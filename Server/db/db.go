// Package db provides database access for the OwnCord server.
// It uses modernc.org/sqlite — a pure-Go SQLite driver requiring no CGO.
package db

import (
	"database/sql"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/owncord/server/migrations"
	_ "modernc.org/sqlite" // register the sqlite3 driver
)

// DB wraps *sql.DB and exposes the subset of methods needed by the server.
type DB struct {
	sqlDB *sql.DB
}

// Open opens (or creates) a SQLite database at path, enables WAL mode and
// foreign key enforcement, and returns a ready-to-use DB.
func Open(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}

	// Verify the connection is actually usable.
	if err := sqlDB.Ping(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// In-memory databases are per-connection in SQLite; pin to one connection
	// so all callers share the same in-memory state.
	if path == ":memory:" {
		sqlDB.SetMaxOpenConns(1)
	}

	// Enable WAL mode for better concurrent read performance.
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL;"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enabling WAL mode: %w", err)
	}

	// Enforce foreign key constraints.
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enabling foreign keys: %w", err)
	}

	return &DB{sqlDB: sqlDB}, nil
}

// Migrate runs all SQL migration files from the embedded migrations FS in
// lexicographic order. It is idempotent — SQL uses IF NOT EXISTS / INSERT OR
// IGNORE, so re-running is safe.
func Migrate(database *DB) error {
	return MigrateFS(database, migrations.FS)
}

// MigrateFS runs all *.sql files from the given FS in sorted order.
// This is exposed for testing with custom FS implementations.
func MigrateFS(database *DB, fsys fs.FS) error {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return fmt.Errorf("reading migrations dir: %w", err)
	}

	// Sort files to ensure deterministic order.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Name() < entries[j].Name()
	})

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}

		raw, readErr := fs.ReadFile(fsys, entry.Name())
		if readErr != nil {
			return fmt.Errorf("reading migration %s: %w", entry.Name(), readErr)
		}

		if _, execErr := database.sqlDB.Exec(string(raw)); execErr != nil {
			return fmt.Errorf("executing migration %s: %w", entry.Name(), execErr)
		}
	}

	return nil
}

// Close releases the underlying database connection.
func (d *DB) Close() error {
	return d.sqlDB.Close()
}

// QueryRow executes a query that returns at most one row.
func (d *DB) QueryRow(query string, args ...interface{}) *sql.Row {
	return d.sqlDB.QueryRow(query, args...)
}

// Exec executes a query that doesn't return rows.
func (d *DB) Exec(query string, args ...interface{}) (sql.Result, error) {
	return d.sqlDB.Exec(query, args...)
}

// Query executes a query that returns multiple rows.
func (d *DB) Query(query string, args ...interface{}) (*sql.Rows, error) {
	return d.sqlDB.Query(query, args...)
}

// Begin starts a database transaction.
func (d *DB) Begin() (*sql.Tx, error) {
	return d.sqlDB.Begin()
}

// SQLDb returns the underlying *sql.DB for cases requiring direct access.
func (d *DB) SQLDb() *sql.DB {
	return d.sqlDB
}
