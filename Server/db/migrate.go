package db

// Tracked migration runner. Each .sql file is applied once; schema_versions
// records each filename and UTC timestamp. Every statement, bookkeeping reads
// included, runs on the writer pool so DDL and its records are observed on one
// connection. A database that predates tracking (a "users" table but no
// schema_versions) is seeded: all filenames are recorded without executing, since
// re-running migrations could destroy data.

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

// ErrSchemaAhead is returned when schema_versions records a migration this binary
// lacks, i.e. a NEWER server migrated the database; an older binary would lose it
// (docs/deployment.md), so start-up and restore refuse.
var ErrSchemaAhead = errors.New("database schema is newer than this server")

// schemaVersionsAheadOf returns the recorded filenames the given set lacks,
// sorted; no schema_versions table means none ahead.
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

func schemaAheadError(ahead []string) error {
	return fmt.Errorf("%w: unknown migration(s) %s; this database was migrated by a newer server. Restore the pre-upgrade archive or follow Server/rollback/README.md before starting this version",
		ErrSchemaAhead, strings.Join(ahead, ", "))
}

// CheckBackupSchemaAhead opens the SQLite file read-only and returns the migrations it
// records that this binary lacks, so a restore refuses it before replacing the live
// database.
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

func ensureSchemaVersions(d *DB) error {
	if _, err := d.writer.Exec(createSchemaVersions); err != nil {
		return fmt.Errorf("creating schema_versions: %w", err)
	}
	return nil
}

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

// seedExistingDatabase creates schema_versions and inserts all filenames
// without executing them, atomically. The CREATE shares the INSERTs'
// transaction (SQLite DDL is transactional): an empty table left by an
// interruption would make the next run skip seeding and replay every
// migration against populated data.
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

// MigrateFS runs tracked migrations from the FS: an existing untracked database is
// seeded atomically (one transaction, so an interruption leaves nothing and the next
// run retries); otherwise schema_versions is created if absent and each unrecorded
// .sql file is applied in lexicographic order.
func MigrateFS(database *DB, fsys fs.FS) error {
	_, err := migrateFSCount(database, fsys)
	return err
}

// migrateFSCount is MigrateFS reporting how many migrations executed, so Migrate
// can skip the boot ANALYZE; seeding reports 0.
func migrateFSCount(database *DB, fsys fs.FS) (int, error) {
	// Read tracking state first: seeding must create schema_versions atomically with its rows, so
	// ensureSchemaVersions must not run before it.
	svExists, err := schemaVersionsExists(database)
	if err != nil {
		return 0, err
	}

	filenames, err := sqlFilenames(fsys)
	if err != nil {
		return 0, err
	}

	if !svExists {
		existing, checkErr := isExistingDatabase(database)
		if checkErr != nil {
			return 0, checkErr
		}
		if existing {
			return 0, seedExistingDatabase(database, filenames)
		}
	}

	if err := ensureSchemaVersions(database); err != nil {
		return 0, err
	}

	// Refuse a schema a newer server produced, or an older binary would boot on
	// it and could corrupt it. Manual rollback reversals delete their own
	// schema_versions row, so the supported path is not blocked.
	recorded, err := recordedSchemaVersions(database)
	if err != nil {
		return 0, err
	}
	if ahead := schemaVersionsAheadOf(recorded, filenames); len(ahead) > 0 {
		return 0, schemaAheadError(ahead)
	}

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

	if appliedCount > 0 {
		slog.Info("db: migrations applied", "count", appliedCount, "ms", totalElapsed.Milliseconds())
	}
	return appliedCount, nil
}

// applyMigration executes one migration and records it, statement by statement, so a
// "duplicate column" error from a prior partial run is skipped (its intent is
// satisfied).
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

	// Record the migration in the same transaction, so it and its tracking row are atomic.
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

// splitStatements splits raw SQL on semicolons, keeping BEGIN...END trigger
// blocks whole; empty/comment-only fragments are discarded.
func splitStatements(raw string) []string {
	out := make([]string, 0)
	var buf strings.Builder
	depth := 0

	for line := range strings.SplitSeq(raw, "\n") {
		trimmed := strings.TrimSpace(line)

		upperTrimmed := strings.ToUpper(trimmed)
		if depth > 0 && (upperTrimmed == "END;" || upperTrimmed == "END") {
			depth--
			buf.WriteString(line)
			buf.WriteString("\n")
			if depth == 0 {
				s := strings.TrimSpace(buf.String())
				s = strings.TrimRight(s, ";")
				s = strings.TrimSpace(s)
				if s != "" && !isCommentOnly(s) {
					out = append(out, s)
				}
				buf.Reset()
			}
			continue
		}

		if strings.HasSuffix(upperTrimmed, " BEGIN") || upperTrimmed == "BEGIN" {
			depth++
			buf.WriteString(line)
			buf.WriteString("\n")
			continue
		}

		if depth > 0 {
			buf.WriteString(line)
			buf.WriteString("\n")
			continue
		}

		buf.WriteString(line)
		buf.WriteString("\n")

		content := buf.String()
		if strings.Contains(content, ";") {
			parts := strings.Split(content, ";")
			for _, p := range parts[:len(parts)-1] {
				s := strings.TrimSpace(p)
				if s == "" || isCommentOnly(s) {
					continue
				}
				out = append(out, s)
			}
			buf.Reset()
			buf.WriteString(parts[len(parts)-1])
		}
	}

	s := strings.TrimSpace(buf.String())
	if s != "" && !isCommentOnly(s) {
		out = append(out, s)
	}

	return out
}

func isCommentOnly(s string) bool {
	for line := range strings.SplitSeq(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "--") {
			return false
		}
	}
	return true
}

func isDuplicateColumn(err error) bool {
	return err != nil && strings.Contains(err.Error(), "duplicate column name")
}
