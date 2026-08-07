// Package db provides database access for the OwnCord server.
// It uses modernc.org/sqlite — a pure-Go SQLite driver requiring no CGO.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/owncord/server/db/dbgen"
	"github.com/owncord/server/migrations"
	_ "modernc.org/sqlite" // register the sqlite3 driver
)

// DB wraps the underlying SQLite pools and exposes the subset of methods
// needed by the server.
//
// q is the sqlc-generated query layer (db/dbgen). Query method bodies delegate
// to it — sqlc is the source of truth for the SQL text and parameter binding
// (verified in CI by `make sqlc-verify`), while this package keeps the stable
// public API and the domain model types the rest of the server consumes.
// Migration is incremental (decision D2); methods not yet delegated still run
// their raw SQL directly against writer/reader.
type DB struct {
	// writer is a single-connection pool that owns every statement that can
	// mutate the database: INSERT/UPDATE/DELETE (including RETURNING forms),
	// transactions, migrations, ANALYZE/VACUUM and PRAGMA writes. Pinning
	// writes to one connection makes concurrent writers queue on the Go side
	// instead of colliding on SQLite's single write lock.
	writer *sql.DB

	// reader is a multi-connection pool serving read-only statements
	// (SELECT / PRAGMA reads). Under WAL, readers run concurrently with each
	// other and with the writer, which is the point of the split. For
	// in-memory databases reader and writer are the same handle.
	reader *sql.DB

	q *dbgen.Queries

	// auditWriter, when installed via SetAuditWriter (main.go server
	// startup only), turns WriteAudit calls backed by this DB into
	// non-blocking enqueues. Nil (the default) keeps audit writes
	// synchronous — the token CLI and tests rely on that.
	auditWriter atomic.Pointer[AuditWriter]
}

// filePragmas are the per-connection PRAGMAs applied to every file-backed
// connection via `_pragma=` DSN parameters (modernc.org/sqlite executes each
// one in newConn, busy_timeout first). They MUST be in the DSN rather than
// Exec'd after Open: with a pool larger than one connection an Exec'd PRAGMA
// lands on one arbitrary connection and every other connection would silently
// run with foreign_keys=OFF.
const filePragmas = "_pragma=busy_timeout(5000)" + // wait up to 5s for the write lock instead of failing instantly
	"&_pragma=journal_mode(WAL)" + // WAL: readers don't block the writer and vice versa
	"&_pragma=foreign_keys(1)" + // enforce foreign key constraints
	"&_pragma=synchronous(NORMAL)" + // performance tuning, safe with WAL
	"&_pragma=temp_store(MEMORY)" +
	"&_pragma=mmap_size(268435456)" +
	"&_pragma=cache_size(-64000)"

// sqliteTimeLayout is how SQLite's own datetime('now') writes a timestamp, and
// therefore the only shape a Go-side cutoff may take when it is compared against
// such a column: the comparison is bytewise TEXT, so RFC3339's 'T' separator
// sorts after the space and quietly turns "older than X" into "any earlier date".
const sqliteTimeLayout = "2006-01-02 15:04:05"

// isMemoryPath reports whether path names an in-memory database
// (":memory:", "file::memory:" or any URI carrying mode=memory).
func isMemoryPath(path string) bool {
	return strings.Contains(path, ":memory:") || strings.Contains(path, "mode=memory")
}

// Open opens (or creates) a SQLite database at path, enables WAL mode and
// foreign key enforcement, and returns a ready-to-use DB.
//
// Two modes:
//
//   - In-memory databases keep the historical single-handle behavior: one
//     *sql.DB pinned to a single connection with the PRAGMAs Exec'd once.
//     A one-connection pool makes DSN PRAGMAs unnecessary, all callers share
//     the same in-memory state, and connection-scoped PRAGMA toggles in tests
//     (e.g. temporarily disabling foreign_keys) behave deterministically.
//     In this mode reader and writer are the same handle.
//
//   - File-backed databases get a reader/writer pool split. Both pools carry
//     the PRAGMAs in the DSN so every physical connection is configured
//     identically. The writer is additionally opened with _txlock=immediate
//     so explicit transactions take the write lock up front instead of
//     failing with SQLITE_BUSY on upgrade.
//
// Path assumptions (file mode): path is either a plain filesystem path or an
// existing file: URI. It must not contain '?', '#' or '%' characters — the
// path is embedded in a file: URI without escaping. cfg.Database.Path is a
// plain path (default "data/chatserver.db"), which satisfies this.
func Open(path string) (*DB, error) {
	if isMemoryPath(path) {
		return openMemory(path)
	}
	return openFile(path)
}

// openMemory preserves the pre-split behavior exactly: a single connection
// with PRAGMAs applied by Exec. reader == writer.
func openMemory(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}

	// Verify the connection is actually usable.
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// A single connection ensures all callers share the same in-memory state
	// and makes the Exec'd PRAGMAs below apply to every future statement.
	sqlDB.SetMaxOpenConns(1)

	// The same PRAGMA set as filePragmas, Exec'd because there is exactly one
	// connection to configure. journal_mode is a no-op for :memory: (SQLite
	// reports "memory") but is kept for symmetry with file mode.
	for _, p := range []struct{ name, stmt string }{
		{"enabling WAL mode", "PRAGMA journal_mode=WAL;"},
		{"setting busy_timeout", "PRAGMA busy_timeout=5000;"},
		{"enabling foreign keys", "PRAGMA foreign_keys=ON;"},
		{"setting synchronous mode", "PRAGMA synchronous=NORMAL;"},
		{"setting temp_store", "PRAGMA temp_store=MEMORY;"},
		{"setting mmap_size", "PRAGMA mmap_size=268435456;"},
		{"setting cache_size", "PRAGMA cache_size=-64000;"},
	} {
		if _, err := sqlDB.Exec(p.stmt); err != nil {
			_ = sqlDB.Close()
			return nil, fmt.Errorf("%s: %w", p.name, err)
		}
	}

	return newDB(sqlDB, sqlDB), nil
}

// openFile opens the writer and reader pools for a file-backed database.
func openFile(path string) (*DB, error) {
	base := path
	if !strings.HasPrefix(base, "file:") {
		base = "file:" + base
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	dsn := base + sep + filePragmas

	// Writer: one connection so concurrent writes queue on the Go side, with
	// BEGIN IMMEDIATE transactions (see Open doc).
	writer, err := sql.Open("sqlite", dsn+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}
	writer.SetMaxOpenConns(1)

	// Verify the connection is actually usable (this also creates the file,
	// so the reader below never races file creation).
	if err := writer.Ping(); err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// Reader: sized for concurrent request handling. Idle == open so warm
	// connections (and their page caches) are kept rather than churned.
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("opening sqlite reader pool: %w", err)
	}
	readConns := max(4, runtime.NumCPU())
	reader.SetMaxOpenConns(readConns)
	reader.SetMaxIdleConns(readConns)
	if err := reader.Ping(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, fmt.Errorf("pinging sqlite reader pool: %w", err)
	}

	return newDB(writer, reader), nil
}

// newDB assembles a DB whose sqlc query layer routes through dbtx.
func newDB(writer, reader *sql.DB) *DB {
	return &DB{
		writer: writer,
		reader: reader,
		q:      dbgen.New(&dbtx{writer: writer, reader: reader}),
	}
}

// dbtx routes statements between the reader and writer pools. It satisfies
// sqlc's DBTX interface (db/dbgen/db.go) so the generated query layer picks
// the correct pool per statement without touching generated code, and it
// backs the DB.QueryContext/QueryRowContext wrappers for the same reason.
//
// Routing table:
//
//   - ExecContext → writer.
//   - PrepareContext → writer. sqlc's generated code in this repo prepares
//     nothing through DBTX (only *sql.Tx.PrepareContext inside the batch
//     persisters, which already run on writer transactions); this method
//     exists for interface completeness. Tradeoff: if a future caller
//     prepared a hot SELECT here it would run serialized on the writer.
//   - QueryContext / QueryRowContext → reader, but only when the statement
//     is provably read-only (isReadOnlySQL). sqlc routes
//     INSERT/UPDATE/DELETE ... RETURNING statements through
//     QueryRowContext/QueryContext (messages, attachments), and those writes
//     must stay on the single writer connection; anything not provably
//     read-only conservatively falls back to the writer.
//
// For in-memory databases writer == reader, so routing degenerates to the
// historical single-handle behavior.
type dbtx struct {
	writer *sql.DB
	reader *sql.DB
}

func (t *dbtx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.writer.ExecContext(ctx, query, args...)
}

func (t *dbtx) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	return t.writer.PrepareContext(ctx, query)
}

func (t *dbtx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return t.pool(query).QueryContext(ctx, query, args...)
}

func (t *dbtx) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return t.pool(query).QueryRowContext(ctx, query, args...)
}

// pool selects the reader for read-only statements and the writer otherwise.
func (t *dbtx) pool(query string) *sql.DB {
	if isReadOnlySQL(query) {
		return t.reader
	}
	return t.writer
}

// isReadOnlySQL reports whether the statement's leading keyword — after
// skipping whitespace and `--` line comments — is SELECT or PRAGMA. Comment
// skipping matters because sqlc-generated SQL starts with a `-- name: ...`
// line. Anything unrecognized (including `/* */` block comments, which this
// package does not use) is conservatively treated as a write.
func isReadOnlySQL(query string) bool {
	s := query
	for {
		s = strings.TrimLeft(s, " \t\r\n")
		if !strings.HasPrefix(s, "--") {
			break
		}
		nl := strings.IndexByte(s, '\n')
		if nl < 0 {
			return false // comment-only "statement" — let the writer reject it
		}
		s = s[nl+1:]
	}
	return hasKeywordPrefix(s, "SELECT") || hasKeywordPrefix(s, "PRAGMA")
}

// hasKeywordPrefix reports whether s starts with the keyword (ASCII
// case-insensitive) followed by a non-identifier character or end of input.
func hasKeywordPrefix(s, keyword string) bool {
	if len(s) < len(keyword) || !strings.EqualFold(s[:len(keyword)], keyword) {
		return false
	}
	if len(s) == len(keyword) {
		return true
	}
	c := s[len(keyword)]
	return c != '_' && (c < '0' || c > '9') && (c < 'a' || c > 'z') && (c < 'A' || c > 'Z')
}

// Migrate runs all SQL migration files from the embedded migrations FS in
// lexicographic order, applying each file exactly once.  It delegates to
// MigrateFS (defined in migrate.go) which maintains the schema_versions
// tracking table.
func Migrate(database *DB) error {
	if err := MigrateFS(database, migrations.FS); err != nil {
		return err
	}
	// Refresh the query planner's statistics once per startup so newly created
	// indexes (e.g. migration 019) are actually chosen. Close() keeps them
	// current afterwards via PRAGMA optimize. ANALYZE writes sqlite_stat rows,
	// so it runs on the writer.
	if _, err := database.writer.Exec("ANALYZE;"); err != nil {
		return fmt.Errorf("running ANALYZE after migrations: %w", err)
	}
	return nil
}

// Close releases the underlying database connections (both pools).
func (d *DB) Close() error {
	// Run PRAGMA optimize to analyze and update query planner statistics.
	// It may write statistics, so it runs on the writer.
	_, _ = d.writer.Exec("PRAGMA optimize;")
	var readerErr error
	if d.reader != d.writer {
		readerErr = d.reader.Close()
	}
	return errors.Join(d.writer.Close(), readerErr)
}

// QueryRowContext executes a query that returns at most one row, with context.
// Read-only statements run on the reader pool; anything else on the writer.
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.routePool(query).QueryRowContext(ctx, query, args...)
}

// ExecContext executes a query that doesn't return rows, with context.
// Always runs on the writer.
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return d.writer.ExecContext(ctx, query, args...)
}

// QueryContext executes a query that returns multiple rows, with context.
// Read-only statements run on the reader pool; anything else on the writer.
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.routePool(query).QueryContext(ctx, query, args...)
}

// routePool mirrors dbtx.pool for the public wrapper methods.
func (d *DB) routePool(query string) *sql.DB {
	if isReadOnlySQL(query) {
		return d.reader
	}
	return d.writer
}

// BeginTx starts a database transaction with context and options.
// Transactions always run on the writer (file-backed writers BEGIN IMMEDIATE
// via _txlock, so the write lock is taken up front).
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	return d.writer.BeginTx(ctx, opts)
}

// SQLDb returns the underlying writer *sql.DB for cases requiring direct
// access. It is the escape hatch for statements the wrappers can't route —
// notably PRAGMA wal_checkpoint(TRUNCATE) in the admin backup handler, which
// must run on the writer to checkpoint the WAL it just stopped appending to.
func (d *DB) SQLDb() *sql.DB {
	return d.writer
}
