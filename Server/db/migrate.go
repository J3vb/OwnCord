package db

// migrate.go — tracked migration runner for the OwnCord server.
//
// Each .sql file in the provided FS is applied exactly once.  The
// schema_versions table records every applied migration filename and the UTC
// timestamp at which it was applied.
//
// Every statement here — including the schema_versions bookkeeping reads —
// runs on the writer pool so migration DDL and its tracking records are
// applied and observed on the single write connection.
//
// Seeding for existing databases
// --------------------------------
// When the server is first upgraded to include migration tracking, existing
// databases will have all schema tables in place but no schema_versions table.
// Without seeding, every migration would re-run and could destroy data.
//
// The seeding heuristic: if schema_versions does not exist AND the "users"
// table already exists, we assume all migrations in the current FS have
// already been applied.  We create schema_versions and insert every migration
// filename without executing the SQL, so subsequent runs treat them as done.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"

	"github.com/J3vb/OwnCord/Server/migrations"
)

// ErrSchemaAhead is returned when schema_versions records a migration the
// running binary does not carry — the database was migrated by a NEWER server.
// Continuing would run this older binary against a schema it has never seen,
// which is the documented way to lose the database (docs/deployment.md), so
// start-up and backup restore both refuse it.
var ErrSchemaAhead = errors.New("database schema is newer than this server")

// schemaVersionsAheadOf returns the recorded migration filenames the given
// set does not contain, sorted. A database with no schema_versions table yet
// (pre-tracking, or a fresh file) has nothing ahead of it. Both start-up
// (migrateFSCount) and the restore guard (CheckBackupSchemaAhead) compare
// through it.
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

// CheckBackupSchemaAhead opens the SQLite file at path read-only and reports
// whether its schema_versions names migrations that are absent from the
// running binary's embedded migration set — the database was migrated by a
// NEWER server. The admin restore path uses it to refuse such a backup BEFORE
// it replaces the live database. A missing schema_versions table (a
// pre-tracking or corrupt file) returns no unknowns — integrity_check has
// already rejected a file SQLite cannot read.
func CheckBackupSchemaAhead(ctx context.Context, path string) ([]string, error) {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return nil, fmt.Errorf("CheckBackupSchemaAhead: resolving path: %w", err)
	}
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(abs)+"?mode=ro&_pragma=busy_timeout(2000)")
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
// migration filenames into it without executing them, atomically. This is
// called once when upgrading a pre-tracking database.
//
// The CREATE TABLE runs inside the same transaction as the INSERTs — SQLite
// DDL is transactional — so a failure or interruption partway through
// leaves no schema_versions table behind at all, rather than an empty one.
// An empty-but-present table would make the next MigrateFS call believe
// tracking is already in place, permanently skip seeding, and replay every
// migration against the live, already-populated database.
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

// MigrateFS runs tracked migrations from the provided FS.
//
// Behaviour:
//  1. If this is the first run with tracking on an existing database (no
//     schema_versions table yet, but the "users" table already exists),
//     atomically create schema_versions and seed it with every filename so
//     none of them are re-executed. Creation and seeding happen in one
//     transaction: a failure or interruption partway through leaves no
//     schema_versions table behind, so the next run retries seeding instead
//     of silently treating tracking as already in place.
//  2. Otherwise, create schema_versions if absent (idempotent — the correct
//     state for a fresh database is an empty tracking table) and apply any
//     .sql file in lexicographic order that is not yet recorded.
func MigrateFS(database *DB, fsys fs.FS) error {
	_, err := migrateFSCount(database, fsys)
	return err
}

// migrateFSCount is MigrateFS reporting how many migrations actually
// executed, so Migrate can skip the boot-time ANALYZE when the schema did not
// change. The seeding path reports 0 — it records filenames without running
// any SQL.
func migrateFSCount(database *DB, fsys fs.FS) (int, error) {
	// Determine tracking state before touching schema_versions at all — the
	// seeding path below must be the one to create it, atomically with the
	// seed rows, so do not call ensureSchemaVersions before this check.
	svExists, err := schemaVersionsExists(database)
	if err != nil {
		return 0, err
	}

	// Collect filenames first — needed for both seeding and normal application.
	filenames, err := sqlFilenames(fsys)
	if err != nil {
		return 0, err
	}

	// Seeding path: schema_versions did not exist AND users table does, which
	// means this is an existing database being upgraded to tracked migrations.
	if !svExists {
		existing, checkErr := isExistingDatabase(database)
		if checkErr != nil {
			return 0, checkErr
		}
		if existing {
			return 0, seedExistingDatabase(database, filenames)
		}
	}

	// Non-seeding paths: schema_versions already exists, or this is a fresh
	// database with no prior schema — either way, an idempotent create is
	// the correct next step before applying migrations normally.
	if err := ensureSchemaVersions(database); err != nil {
		return 0, err
	}

	// Refuse a schema a newer server produced (REL-02). migrateFSCount only
	// looked at embedded files before, so an older binary booted silently on a
	// newer database and could corrupt it. The manual rollback reversals each
	// delete their own schema_versions row, so the supported path is not
	// blocked by this.
	recorded, err := recordedSchemaVersions(database)
	if err != nil {
		return 0, err
	}
	if ahead := schemaVersionsAheadOf(recorded, filenames); len(ahead) > 0 {
		return 0, schemaAheadError(ahead)
	}

	// Normal path: apply any migration not yet recorded.
	appliedCount := 0
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

		if err := applyMigration(database, name, string(raw)); err != nil {
			return appliedCount, err
		}
		appliedCount++
	}

	return appliedCount, nil
}

// applyMigration executes a single migration and records it. If the
// migration contains multiple statements (e.g. several ALTER TABLE ADD
// COLUMN), each is executed individually so that "duplicate column" errors
// from a prior partial run can be skipped — the column already exists and
// the intent is satisfied.
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

	// Record the migration inside the same transaction so the migration
	// and its tracking record are atomic.
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

		// Detect BEGIN that opens a trigger body. The keyword appears at
		// the end of a CREATE TRIGGER line (e.g. "... BEGIN") or on its
		// own line inside a trigger definition.
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

		// Check whether the accumulated buffer contains a semicolon to split on.
		// We split the full buffer content, not just the current line, because a
		// statement may span multiple lines before its terminating semicolon.
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
