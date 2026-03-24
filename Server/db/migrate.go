package db

// migrate.go — tracked migration runner for the OwnCord server.
//
// Each .sql file in the provided FS is applied exactly once.  The
// schema_versions table records every applied migration filename and the UTC
// timestamp at which it was applied.
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
	"fmt"
	"io/fs"
	"sort"
	"strings"
)

const createSchemaVersions = `
CREATE TABLE IF NOT EXISTS schema_versions (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

// ensureSchemaVersions creates the tracking table if it does not yet exist.
func ensureSchemaVersions(d *DB) error {
	if _, err := d.sqlDB.Exec(createSchemaVersions); err != nil {
		return fmt.Errorf("creating schema_versions: %w", err)
	}
	return nil
}

// isExistingDatabase reports whether the database was previously migrated
// without tracking — detected by the presence of the "users" table.
func isExistingDatabase(d *DB) (bool, error) {
	var name string
	err := d.sqlDB.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='users'",
	).Scan(&name)
	if err != nil {
		// sql.ErrNoRows means the table does not exist.
		return false, nil
	}
	return true, nil
}

// schemaVersionsExists reports whether the schema_versions table is present.
func schemaVersionsExists(d *DB) (bool, error) {
	var name string
	err := d.sqlDB.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'",
	).Scan(&name)
	if err != nil {
		return false, nil
	}
	return true, nil
}

// isApplied reports whether a migration filename has already been recorded.
func isApplied(d *DB, filename string) (bool, error) {
	var v string
	err := d.sqlDB.QueryRow(
		"SELECT version FROM schema_versions WHERE version = ?", filename,
	).Scan(&v)
	if err != nil {
		return false, nil
	}
	return true, nil
}

// recordApplied inserts a migration filename into schema_versions.
func recordApplied(d *DB, filename string) error {
	_, err := d.sqlDB.Exec(
		"INSERT INTO schema_versions (version) VALUES (?)", filename,
	)
	if err != nil {
		return fmt.Errorf("recording migration %s: %w", filename, err)
	}
	return nil
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

// seedExistingDatabase inserts all migration filenames into schema_versions
// without executing them.  This is called once when upgrading a pre-tracking
// database.
func seedExistingDatabase(d *DB, filenames []string) error {
	for _, name := range filenames {
		if err := recordApplied(d, name); err != nil {
			return fmt.Errorf("seeding %s: %w", name, err)
		}
	}
	return nil
}

// MigrateFS runs tracked migrations from the provided FS.
//
// Behaviour:
//  1. Create schema_versions if absent.
//  2. If this is the first run with tracking on an existing database (users
//     table exists but schema_versions was just created), seed all filenames
//     so they are not re-executed.
//  3. For each .sql file in lexicographic order: skip if already recorded,
//     otherwise execute the SQL and record the filename.
func MigrateFS(database *DB, fsys fs.FS) error {
	// Determine tracking state before we create schema_versions.
	svExists, err := schemaVersionsExists(database)
	if err != nil {
		return err
	}

	// Create the tracking table (idempotent).
	if err := ensureSchemaVersions(database); err != nil {
		return err
	}

	// Collect filenames first — needed for both seeding and normal application.
	filenames, err := sqlFilenames(fsys)
	if err != nil {
		return err
	}

	// Seeding path: schema_versions did not exist AND users table does, which
	// means this is an existing database being upgraded to tracked migrations.
	if !svExists {
		existing, checkErr := isExistingDatabase(database)
		if checkErr != nil {
			return checkErr
		}
		if existing {
			return seedExistingDatabase(database, filenames)
		}
	}

	// Normal path: apply any migration not yet recorded.
	for _, name := range filenames {
		applied, applyErr := isApplied(database, name)
		if applyErr != nil {
			return applyErr
		}
		if applied {
			continue
		}

		tx, txErr := database.sqlDB.Begin()
		if txErr != nil {
			return fmt.Errorf("begin tx for %s: %w", name, txErr)
		}

		raw, readErr := fs.ReadFile(fsys, name)
		if readErr != nil {
			tx.Rollback() //nolint:errcheck
			return fmt.Errorf("reading migration %s: %w", name, readErr)
		}

		if _, execErr := tx.Exec(string(raw)); execErr != nil {
			tx.Rollback() //nolint:errcheck
			return fmt.Errorf("executing migration %s: %w", name, execErr)
		}

		if commitErr := tx.Commit(); commitErr != nil {
			return fmt.Errorf("commit migration %s: %w", name, commitErr)
		}

		if err := recordApplied(database, name); err != nil {
			return err
		}
	}

	return nil
}
