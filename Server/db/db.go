// Package db provides database access for the OwnCord server.
// It uses modernc.org/sqlite — a pure-Go SQLite driver requiring no CGO.
package db

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/owncord/server/db/dbgen"
	"github.com/owncord/server/migrations"
	_ "modernc.org/sqlite" // register the sqlite3 driver
)

// DB wraps *sql.DB and exposes the subset of methods needed by the server.
//
// q is the sqlc-generated query layer (db/dbgen). Query method bodies delegate
// to it — sqlc is the source of truth for the SQL text and parameter binding
// (verified in CI by `make sqlc-verify`), while this package keeps the stable
// public API and the domain model types the rest of the server consumes.
// Migration is incremental (decision D2); methods not yet delegated still run
// their raw SQL directly against sqlDB.
type DB struct {
	sqlDB *sql.DB
	q     *dbgen.Queries
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
		_ = sqlDB.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// SQLite only allows one writer at a time. Pin to a single connection
	// so concurrent goroutines queue on the Go side rather than getting
	// SQLITE_BUSY. For :memory: databases this also ensures all callers
	// share the same in-memory state.
	sqlDB.SetMaxOpenConns(1)

	// Enable WAL mode for better concurrent read performance.
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("enabling WAL mode: %w", err)
	}

	// Wait up to 5 seconds for the write lock instead of failing instantly.
	if _, err := sqlDB.Exec("PRAGMA busy_timeout=5000;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("setting busy_timeout: %w", err)
	}

	// Enforce foreign key constraints.
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("enabling foreign keys: %w", err)
	}

	// Performance tuning (safe with WAL mode).
	if _, err := sqlDB.Exec("PRAGMA synchronous=NORMAL;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("setting synchronous mode: %w", err)
	}
	if _, err := sqlDB.Exec("PRAGMA temp_store=MEMORY;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("setting temp_store: %w", err)
	}
	if _, err := sqlDB.Exec("PRAGMA mmap_size=268435456;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("setting mmap_size: %w", err)
	}
	if _, err := sqlDB.Exec("PRAGMA cache_size=-64000;"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("setting cache_size: %w", err)
	}

	return &DB{sqlDB: sqlDB, q: dbgen.New(sqlDB)}, nil
}

// Migrate runs all SQL migration files from the embedded migrations FS in
// lexicographic order, applying each file exactly once.  It delegates to
// MigrateFS (defined in migrate.go) which maintains the schema_versions
// tracking table.
func Migrate(database *DB) error {
	return MigrateFS(database, migrations.FS)
}

// Close releases the underlying database connection.
func (d *DB) Close() error {
	// Run PRAGMA optimize to analyze and update query planner statistics.
	_, _ = d.sqlDB.Exec("PRAGMA optimize;")
	return d.sqlDB.Close()
}

// QueryRowContext executes a query that returns at most one row, with context.
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.sqlDB.QueryRowContext(ctx, query, args...)
}

// ExecContext executes a query that doesn't return rows, with context.
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return d.sqlDB.ExecContext(ctx, query, args...)
}

// QueryContext executes a query that returns multiple rows, with context.
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.sqlDB.QueryContext(ctx, query, args...)
}

// BeginTx starts a database transaction with context and options.
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	return d.sqlDB.BeginTx(ctx, opts)
}

// SQLDb returns the underlying *sql.DB for cases requiring direct access.
func (d *DB) SQLDb() *sql.DB {
	return d.sqlDB
}
