package db

// Tracked migration runner. Each .sql file in the FS is applied exactly once;
// schema_versions records every applied filename and its UTC timestamp. Every
// statement, including the schema_versions bookkeeping reads, runs on the
// writer pool so DDL and its tracking records are applied and observed on the
// single write connection.
//
// Seeding: a database that predates tracking has its tables but no
// schema_versions. Without seeding every migration would re-run and could
// destroy data, so if schema_versions is absent and the "users" table exists,
// all migrations in the FS are assumed applied and their filenames are
// inserted without executing the SQL.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/migrations"
)

// ErrSchemaAhead is returned when schema_versions records a migration this
// binary does not carry, i.e. a NEWER server migrated the database. Running an
// older binary against it is the documented way to lose the database
// (docs/deployment.md), so start-up and backup restore both refuse.
var ErrSchemaAhead = errors.New("database schema is newer than this server")

// schemaVersionsAheadOf returns the recorded migration filenames the given set
// lacks, sorted. A database with no schema_versions table has nothing ahead.
// Start-up (migrateFSCount) and the restore guard (CheckBackupSchemaAhead)
// both compare through it.
func schemaVersionsAheadOf(versions []string, filenames []string) []string {
	known := make(map[string]struct{}, len(filenames))
	for _, name := range filenames {
		known[name] = struct{}{}
	}
	var ahead []string
	for _, v := range versions {
		if _, ok := known[v]; !ok {
			ahead = append(ahead, v)
		}
	}
	sort.Strings(ahead)
	return ahead
}

// schemaAheadError is the operator-facing refusal, naming the unknown
// migrations and the documented reversal path.
func schemaAheadError(ahead []string) error {
	return fmt.Errorf("%w: unknown migration(s) %s; this database was migrated by a newer server. Restore the pre-upgrade archive or follow Server/rollback/README.md before starting this version",
		ErrSchemaAhead, strings.Join(ahead, ", "))
}

// CheckBackupSchemaAhead opens the SQLite file at path read-only and returns
// the migrations its schema_versions names that this binary lacks (a NEWER
// server migrated it), so the admin restore refuses it before replacing the
// live database. A missing schema_versions table returns none; integrity_check
// has already rejected a file SQLite cannot read.
func CheckBackupSchemaAhead(ctx context.Context, path string) ([]string, error) {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: resolving path: %w", err)
	}
	conn, err := sql.Open("sqlite", readOnlyURI(abs))
	if err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: open: %w", err)
	}
	defer conn.Close() //nolint:errcheck

	filenames, err := sqlFilenames(migrations.FS)
	if err != nil {
		return nil, err
	}

	var exists string
	err = conn.QueryRowContext(ctx,
		"SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'").Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: %w", err)
	}

	rows, err := conn.QueryContext(ctx, "SELECT version FROM schema_versions")
	if err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: reading schema_versions: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var versions []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("CheckBackupSchemaAhead: %w", err)
		}
		versions = append(versions, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: %w", err)
	}
	return schemaVersionsAheadOf(versions, filenames), nil
}

const createSchemaVersions = `
CREATE TABLE IF NOT EXISTS schema_versions (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

// ensureSchemaVersions creates the tracking table if it does not yet exist.
func ensureSchemaVersions(d *DB) error {
	if _, err := d.writer.Exec(createSchemaVersions); err != nil {
		return fmt.Errorf("creating schema_versions: %w", err)
	}
	return nil
}

// isExistingDatabase reports whether the database was previously migrated
// without tracking — detected by the presence of the "users" table.
func isExistingDatabase(d *DB) (bool, error) {
	var name string
	err := d.writer.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
	).Scan(&name)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("isExistingDatabase: %w", err)
	}
	return true, nil
}

// schemaVersionsExists reports whether the schema_versions table is present.
func schemaVersionsExists(d *DB) (bool, error) {
	var name string
	err := d.writer.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'",
	).Scan(&name)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("schemaVersionsExists: %w", err)
	}
	return true, nil
}

// recordedSchemaVersions returns every version in schema_versions. The table
// must exist (ensureSchemaVersions has run).
func recordedSchemaVersions(d *DB) ([]string, error) {
	rows, err := d.writer.Query("SELECT version FROM schema_versions")
	if err != nil {
		return nil, fmt.Errorf("reading schema_versions: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var versions []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("reading schema_versions: %w", err)
		}
		versions = append(versions, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading schema_versions: %w", err)
	}
	return versions, nil
}

// isApplied reports whether a migration filename has already been recorded.
func isApplied(d *DB, filename string) (bool, error) {
	var v string
	err := d.writer.QueryRow(
		"SELECT version FROM schema_versions WHERE version = ?", filename,
	).Scan(&v)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("isApplied: %w", err)
	}
	return true, nil
}

// sqlFilenames returns all .sql entries from the FS sorted lexicographically.
func sqlFilenames(fsys fs.FS) ([]string, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("reading migrations dir: %w", err)
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

// seedExistingDatabase creates schema_versions (if absent) and inserts all
// migration filenames without executing them, atomically, when upgrading a
// pre-tracking database. The CREATE TABLE shares the INSERTs' transaction
// (SQLite DDL is transactional): an interruption leaves no schema_versions
// table, whereas an empty one would make the next MigrateFS skip seeding for
// good and replay every migration against the populated database.
func seedExistingDatabase(d *DB, filenames []string) error {
	tx, err := d.writer.Begin()
	if err != nil {
		return fmt.Errorf("begin seed tx: %w", err)
	}
	if _, execErr := tx.Exec(createSchemaVersions); execErr != nil {
		_ = tx.Rollback()
		return fmt.Errorf("creating schema_versions in seed tx: %w", execErr)
	}
	for _, name := range filenames {
		if _, execErr := tx.Exec(
			"INSERT INTO schema_versions (version) VALUES (?)", name,
		); execErr != nil {
			_ = tx.Rollback()
			return fmt.Errorf("seeding %s: %w", name, execErr)
		}
	}
	if commitErr := tx.Commit(); commitErr != nil {
		return fmt.Errorf("commit seed tx: %w", commitErr)
	}
	return nil
}

// MigrateFS runs tracked migrations from the FS.
//
//  1. First run with tracking on an existing database (no schema_versions but
//     a "users" table): atomically create schema_versions and seed every
//     filename so none re-executes. One transaction, so an interruption leaves
//     no table and the next run retries seeding.
//  2. Otherwise create schema_versions if absent (idempotent; a fresh database
//     gets an empty one) and apply, in lexicographic order, each .sql file not
//     yet recorded.
func MigrateFS(database *DB, fsys fs.FS) error {
	_, err := migrateFSCount(database, fsys)
	return err
}

// migrateFSCount is MigrateFS reporting how many migrations executed, so
// Migrate can skip the boot-time ANALYZE when the schema did not change. The
// seeding path reports 0 since it runs no SQL.
func migrateFSCount(database *DB, fsys fs.FS) (int, error) {
	// Determine tracking state before touching schema_versions: the seeding path
	// must create it atomically with the seed rows, so ensureSchemaVersions must
	// not run first.
	svExists, err := schemaVersionsExists(database)
	if err != nil {
		return 0, err
	}

	// Filenames are needed for both seeding and normal application.
	filenames, err := sqlFilenames(fsys)
	if err != nil {
		return 0, err
	}

	// Seeding path: schema_versions absent and users present means an existing
	// database being upgraded to tracked migrations.
	if !svExists {
		existing, checkErr := isExistingDatabase(database)
		if checkErr != nil {
			return 0, checkErr
		}
		if existing {
			return 0, seedExistingDatabase(database, filenames)
		}
	}

	// Non-seeding paths: schema_versions exists, or the database is fresh; an
	// idempotent create precedes normal application.
	if err := ensureSchemaVersions(database); err != nil {
		return 0, err
	}

	// Refuse a schema a newer server produced, or an older binary would boot
	// silently on it and could corrupt it. The manual rollback reversals delete
	// their own schema_versions row, so the supported path is not blocked.
	recorded, err := recordedSchemaVersions(database)
	if err != nil {
		return 0, err
	}
	if ahead := schemaVersionsAheadOf(recorded, filenames); len(ahead) > 0 {
		return 0, schemaAheadError(ahead)
	}

	// Normal path: apply any migration not yet recorded.
	appliedCount := 0
	var totalElapsed time.Duration
	for _, name := range filenames {
		applied, applyErr := isApplied(database, name)
		if applyErr != nil {
			return appliedCount, applyErr
		}
		if applied {
			continue
		}

		raw, readErr := fs.ReadFile(fsys, name)
		if readErr != nil {
			return appliedCount, fmt.Errorf("reading migration %s: %w", name, readErr)
		}

		started := time.Now()
		if err := applyMigration(database, name, string(raw)); err != nil {
			return appliedCount, err
		}
		elapsed := time.Since(started)
		totalElapsed += elapsed
		appliedCount++
		slog.Info("db: migration applied", "file", name, "ms", elapsed.Milliseconds())
	}

	// A boot with nothing to apply stays silent; a failed migration returned
	// above, so the summary prints only for a clean run.
	if appliedCount > 0 {
		slog.Info("db: migrations applied", "count", appliedCount, "ms", totalElapsed.Milliseconds())
	}
	return appliedCount, nil
}

// applyMigration executes a single migration and records it. A multi-statement
// migration runs statement by statement so a "duplicate column" error from a
// prior partial run can be skipped, the intent already being satisfied.
func applyMigration(database *DB, name, rawSQL string) error {
	stmts := splitStatements(rawSQL)

	tx, txErr := database.writer.Begin()
	if txErr != nil {
		return fmt.Errorf("begin tx for %s: %w", name, txErr)
	}

	for _, stmt := range stmts {
		if _, execErr := tx.Exec(stmt); execErr != nil {
			if isDuplicateColumn(execErr) {
				continue // column already exists — skip
			}
			_ = tx.Rollback()
			return fmt.Errorf("executing migration %s: %w", name, execErr)
		}
	}

	// Record the migration in the same transaction, so it and its tracking row
	// are atomic.
	if _, execErr := tx.Exec(
		"INSERT INTO schema_versions (version) VALUES (?)", name,
	); execErr != nil {
		_ = tx.Rollback()
		return fmt.Errorf("recording migration %s: %w", name, execErr)
	}

	if commitErr := tx.Commit(); commitErr != nil {
		return fmt.Errorf("commit migration %s: %w", name, commitErr)
	}
	return nil
}

// splitStatements splits raw SQL into individual statements on semicolons,
// correctly handling BEGIN...END blocks used by CREATE TRIGGER definitions.
// Empty/comment-only fragments are discarded.
func splitStatements(raw string) []string {
	out := make([]string, 0)
	var buf strings.Builder
	depth := 0

	for line := range strings.SplitSeq(raw, "\n") {
		trimmed := strings.TrimSpace(line)

		// Track BEGIN...END depth for trigger bodies.
		upperTrimmed := strings.ToUpper(trimmed)
		if depth > 0 && (upperTrimmed == "END;" || upperTrimmed == "END") {
			depth--
			buf.WriteString(line)
			buf.WriteString("\n")
			if depth == 0 {
				// END; closes the trigger — flush the entire block as one statement.
				s := strings.TrimSpace(buf.String())
				// Strip trailing semicolons so the executor doesn't choke.
				s = strings.TrimRight(s, ";")
				s = strings.TrimSpace(s)
				if s != "" && !isCommentOnly(s) {
					out = append(out, s)
				}
				buf.Reset()
			}
			continue
		}

		// Detect BEGIN opening a trigger body: the keyword ends a CREATE TRIGGER
		// line or stands on its own line inside the definition.
		if strings.HasSuffix(upperTrimmed, " BEGIN") || upperTrimmed == "BEGIN" {
			depth++
			buf.WriteString(line)
			buf.WriteString("\n")
			continue
		}

		if depth > 0 {
			// Inside a BEGIN...END block — accumulate without splitting.
			buf.WriteString(line)
			buf.WriteString("\n")
			continue
		}

		// Outside any block — split on semicolons within this line.
		buf.WriteString(line)
		buf.WriteString("\n")

		// Split the full buffer, not just the current line, because a statement may
		// span lines before its terminating semicolon.
		content := buf.String()
		if strings.Contains(content, ";") {
			parts := strings.Split(content, ";")
			// All parts except the last are complete statements.
			for _, p := range parts[:len(parts)-1] {
				s := strings.TrimSpace(p)
				if s == "" || isCommentOnly(s) {
					continue
				}
				out = append(out, s)
			}
			// The last part is the remainder after the final semicolon.
			buf.Reset()
			buf.WriteString(parts[len(parts)-1])
		}
	}

	// Flush any remaining content (statement without trailing semicolon).
	s := strings.TrimSpace(buf.String())
	if s != "" && !isCommentOnly(s) {
		out = append(out, s)
	}

	return out
}

// isCommentOnly returns true if every line is a SQL comment or blank.
func isCommentOnly(s string) bool {
	for line := range strings.SplitSeq(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "--") {
			return false
		}
	}
	return true
}

// isDuplicateColumn reports whether a SQLite error indicates a duplicate
// column name from an ALTER TABLE ADD COLUMN statement.
func isDuplicateColumn(err error) bool {
	return err != nil && strings.Contains(err.Error(), "duplicate column name")
}
