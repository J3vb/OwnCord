// Package db provides database access for the OwnCord server.
// It uses modernc.org/sqlite — a pure-Go SQLite driver requiring no CGO.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/migrations"
	"github.com/J3vb/OwnCord/Server/syncutil"
	_ "modernc.org/sqlite" // register the sqlite3 driver
)

// DB wraps the SQLite reader and writer pools. Query methods delegate to the
// sqlc layer (db/dbgen), the source of truth for SQL text and parameter
// binding; methods not yet delegated run raw SQL against writer/reader.
type DB struct {
	// writer is a single-connection pool that owns every statement that can
	// mutate the database (writes, RETURNING forms, transactions, migrations,
	// ANALYZE/VACUUM, PRAGMA writes), so concurrent writers queue in Go instead
	// of colliding on SQLite's write lock.
	writer *sql.DB

	// reader is a multi-connection pool for read-only statements; under WAL it
	// runs concurrently with the writer. For in-memory databases it is the same
	// handle as writer.
	reader *sql.DB

	q *dbgen.Queries

	// readStmts caches prepared statements for hot read queries (queryCached).
	readStmts readStmtCache

	// auditWriter, when installed via SetAuditWriter (server startup only), makes
	// WriteAudit non-blocking. Nil keeps audit writes synchronous, which the token
	// CLI and tests rely on.
	auditWriter atomic.Pointer[AuditWriter]

	// Loaded from the durable sidecar before serving a restored database.
	messageDeliveryFloor atomic.Int64

	// attachmentBytesCache and activeMessagesCache hold the two whole-table
	// aggregates the metrics scrape and admin stats read.
	attachmentBytesCache syncutil.TTLCache[int64]
	activeMessagesCache  syncutil.TTLCache[int64]

	// closed is set by Close. A backup restore closes the handle while the
	// lifecycle is still up; teardown steps read it through Closed.
	closed atomic.Bool

	// plainMemory is true for a private ":memory:" database, the only kind
	// Migrate may fill from the cached migrated image (migrate_memory.go).
	plainMemory bool

	// walPath is "<path>-wal" for a file-backed database, empty for an
	// in-memory one. WALBytes stats it; nothing else reads it.
	walPath string

	// lockRelease drops the single-process advisory lock taken by openFile.
	// Nil for in-memory databases and when the lock mechanism is unavailable.
	lockRelease func()

	// acceptGuardHook is a test seam called inside AcceptMessageRequest's
	// transaction after it confirms the row is still pending and before it
	// writes. The sole writer connection stays held while it blocks, so a test can
	// provably race a competing TransitionMessageRequest. Nil in production.
	acceptGuardHook func()

	// afterDMParticipantsInsertHook is a test seam called in
	// getOrCreateDMChannel's create branch after the participants insert and
	// before the recipient's visibility is written, to prove the whole
	// transaction rolls back on failure. Nil in production.
	afterDMParticipantsInsertHook func() error

	// checkpointOwed records that an erasure's wal_checkpoint(TRUNCATE) came back
	// blocked or partial, so frames holding erased bytes are still in the -wal.
	// Process-local on purpose: a crash loses it, which is why the start-up pass
	// (CheckpointErasureWAL) runs unconditionally.
	//
	// ponytail: process-local flag; persist in erasure_jobs if a tick ever
	// needs to survive a crash before the startup pass runs
	checkpointOwed atomic.Bool

	// checkpointAttempts counts the retries the flag has driven, for the log
	// line an operator reads when a checkpoint stays blocked.
	checkpointAttempts atomic.Int64

	// testEraseCommitHook is a test seam called by eraseAccount after
	// eraseAccountTx commits and before the wal_checkpoint(TRUNCATE): the window
	// where the erasure is durable but its frames are still in the WAL. The
	// writer connection is held, so the hook must not touch this DB's pools. Nil
	// in production.
	testEraseCommitHook func()
	// testErasureChunkHook is a test seam, see erasure_chunks.go.
	testErasureChunkHook func(stage string, n int) error
}

// filePragmas are the per-connection PRAGMAs applied via `_pragma=` DSN
// parameters (busy_timeout first). They must be in the DSN, not Exec'd after
// Open: with several connections an Exec'd PRAGMA lands on one arbitrary
// connection and the others would run with foreign_keys=OFF.
const filePragmas = "_pragma=busy_timeout(5000)" + // wait up to 5s for the write lock instead of failing instantly
	"&_pragma=journal_mode(WAL)" + // WAL: readers don't block the writer and vice versa
	"&_pragma=foreign_keys(1)" + // enforce foreign key constraints
	"&_pragma=synchronous(NORMAL)" + // performance tuning, safe with WAL
	"&_pragma=temp_store(MEMORY)" +
	"&_pragma=mmap_size(268435456)" +
	"&_pragma=cache_size(-64000)"

// isMemoryPath reports whether path names an in-memory database
// (":memory:", "file::memory:" or any URI carrying mode=memory).
func isMemoryPath(path string) bool {
	return strings.Contains(path, ":memory:") || strings.Contains(path, "mode=memory")
}

// Open opens (or creates) a SQLite database at path, enables WAL mode and
// foreign key enforcement, and returns a ready-to-use DB.
//
// In-memory databases use one *sql.DB pinned to a single connection with the
// PRAGMAs Exec'd once, so callers share state and connection-scoped PRAGMA
// toggles in tests are deterministic; reader and writer are the same handle.
//
// File-backed databases get a reader/writer pool split with the PRAGMAs in
// the DSN of both. The writer is opened with _txlock=immediate so explicit
// transactions take the write lock up front instead of failing with
// SQLITE_BUSY on upgrade. path must be a plain filesystem path or an existing
// file: URI and must not contain '?', '#' or '%', because it is embedded in a
// file: URI without escaping.
func Open(path string) (*DB, error) {
	return OpenWithMaxReaders(path, 0)
}

// OpenWithMaxReaders is Open with an explicit reader-pool bound
// (database.max_readers). maxReaders <= 0 keeps the automatic sizing; values
// are clamped to [1, 64]. Ignored for in-memory databases.
func OpenWithMaxReaders(path string, maxReaders int) (*DB, error) {
	if isMemoryPath(path) {
		return openMemory(path)
	}
	return openFile(path, maxReaders, true)
}

// defaultReaderConns is the automatic reader-pool size: twice the CPU count
// with a floor of 8, clamped to [1, 64]. The floor matters on small hosts,
// where reader waits grew under a connect herd.
func defaultReaderConns(cpus int) int {
	return min(max(8, 2*cpus), 64)
}

// OpenShared opens the database without taking the single-process lock, for
// short-lived tooling (the `server token` CLI) that must work while the server
// runs. SQLite's WAL locking makes that safe at the file level; the process
// lock only protects the server's process-local state. Long-lived processes
// must use Open.
func OpenShared(path string) (*DB, error) {
	if isMemoryPath(path) {
		return openMemory(path)
	}
	return openFile(path, 0, false)
}

// openMemory opens the single-connection in-memory database; reader == writer.
func openMemory(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}

	// Verify the connection is usable.
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// A single connection makes all callers share the in-memory state and the
	// Exec'd PRAGMAs apply to every future statement.
	sqlDB.SetMaxOpenConns(1)

	if err := applyMemoryPragmas(sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}

	d := newDB(sqlDB, sqlDB)
	d.plainMemory = path == ":memory:"
	return d, nil
}

// openFile opens the writer and reader pools for a file-backed database.
// takeLock is false only for OpenShared (short-lived CLI tooling).
func openFile(path string, maxReaders int, takeLock bool) (*DB, error) {
	// Single-process guard: presence, the replay ring, rate-limit windows and the
	// boot-time status reset are process-local and assume one server owns this
	// file, so a second process (double unit, container plus binary) fails fast.
	var release func()
	if takeLock {
		var lockErr error
		release, lockErr = acquireProcessLock(path)
		if lockErr != nil {
			if errors.Is(lockErr, ErrAlreadyLocked) {
				return nil, fmt.Errorf(
					"database %s is in use by another running OwnCord process — stop that process first (the lock is released automatically when it exits)",
					path)
			}
			// The lock mechanism itself failed (e.g. an NFS data dir rejecting advisory
			// locks). Warn and continue; SQLite still protects the file.
			slog.Warn("db: could not take the single-process lock; continuing unprotected",
				"path", lockFilePath(path), "error", lockErr)
			release = nil
		}
	}
	ok := false
	defer func() {
		if !ok && release != nil {
			release()
		}
	}()
	retryFloor, err := prepareOpen(path, takeLock)
	if err != nil {
		return nil, err
	}

	base := path
	if !strings.HasPrefix(base, "file:") {
		base = "file:" + base
	}
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	dsn := base + sep + filePragmas

	// Writer: one connection, BEGIN IMMEDIATE transactions (see Open).
	writer, err := sql.Open("sqlite", dsn+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}
	writer.SetMaxOpenConns(1)

	// Verify the connection is usable; this also creates the file so the reader
	// never races its creation.
	if err := writer.Ping(); err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	// Reader: defaultReaderConns, bounded by database.max_readers. Idle == open so
	// warm connections and their page caches are kept.
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("opening sqlite reader pool: %w", err)
	}
	readConns := defaultReaderConns(runtime.NumCPU())
	if maxReaders > 0 {
		readConns = min(max(maxReaders, 1), 64)
	}
	reader.SetMaxOpenConns(readConns)
	reader.SetMaxIdleConns(readConns)
	if err := reader.Ping(); err != nil {
		_ = reader.Close()
		_ = writer.Close()
		return nil, fmt.Errorf("pinging sqlite reader pool: %w", err)
	}

	d := newDB(writer, reader)
	d.messageDeliveryFloor.Store(retryFloor)
	d.walPath = walFilePath(path)
	d.lockRelease = release
	ok = true
	return d, nil
}

// newDB assembles a DB whose sqlc query layer routes through dbtx.
func newDB(writer, reader *sql.DB) *DB {
	d := &DB{writer: writer, reader: reader}
	d.q = dbgen.New(&dbtx{writer: writer, reader: reader, stmts: &d.readStmts})
	return d
}

// dbtx routes statements between the reader and writer pools and satisfies
// sqlc's DBTX interface. ExecContext and PrepareContext go to the writer
// (nothing prepares a hot SELECT through DBTX today; one would serialize on
// the writer). QueryContext/QueryRowContext go to the reader only when
// isReadOnlySQL proves the statement read-only, because sqlc routes
// INSERT/UPDATE/DELETE ... RETURNING through them and those must stay on the
// writer. In-memory databases have writer == reader.
type dbtx struct {
	writer *sql.DB
	reader *sql.DB
	stmts  *readStmtCache
}

func (t *dbtx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return t.writer.ExecContext(ctx, query, args...)
}

func (t *dbtx) PrepareContext(ctx context.Context, query string) (*sql.Stmt, error) {
	return t.writer.PrepareContext(ctx, query)
}

func (t *dbtx) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	pool := t.pool(query)
	if t.stmts != nil && cachedReads(ctx) && isReadOnlySQL(query) {
		return t.stmts.query(ctx, pool, query, args...)
	}
	return pool.QueryContext(ctx, query, args...)
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

// isReadOnlySQL reports whether the statement's leading keyword, after
// whitespace and `--` line comments, is SELECT or PRAGMA. Skipping comments
// matters because sqlc SQL starts with `-- name: ...`. Anything unrecognized
// (including `/* */`) is treated as a write.
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

// Migrate runs all embedded SQL migrations in lexicographic order, each once,
// via MigrateFS. An empty in-memory database gets a copy of an already
// migrated image instead (migrate_memory.go) with the same result.
func Migrate(database *DB) error {
	if restoreFreshMemory(database) {
		return nil
	}
	return migrateEmbedded(database)
}

func migrateEmbedded(database *DB) error {
	applied, err := migrateFSCount(database, migrations.FS)
	if err != nil {
		return err
	}
	// Refresh the planner's statistics when the schema changed so new indexes are
	// chosen. A full ANALYZE grows with row count and blocks startup, so unchanged
	// schemas get the cheap PRAGMA optimize, which also covers crash-restarts that
	// skipped Close()'s. Both write sqlite_stat rows, so they run on the writer.
	if applied > 0 {
		started := time.Now()
		if _, err := database.writer.Exec("ANALYZE;"); err != nil {
			return fmt.Errorf("running ANALYZE after migrations: %w", err)
		}
		slog.Info("db: analyze done", "ms", time.Since(started).Milliseconds())
		return nil
	}
	started := time.Now()
	if _, err := database.writer.Exec("PRAGMA optimize;"); err != nil {
		return fmt.Errorf("running PRAGMA optimize at startup: %w", err)
	}
	slog.Info("db: optimize done", "ms", time.Since(started).Milliseconds())
	return nil
}

// Close releases the underlying database connections (both pools).
func (d *DB) Close() error {
	d.closed.Store(true)
	// PRAGMA optimize may write statistics, so it runs on the writer.
	_, _ = d.writer.Exec("PRAGMA optimize;")
	var readerErr error
	if d.reader != d.writer {
		readerErr = d.reader.Close()
	}
	writerErr := d.writer.Close()
	// Statements close after the pools: closing a pool wakes a cached query
	// waiting for a connection, which a statement Close would otherwise wait on.
	err := errors.Join(d.readStmts.close(), writerErr, readerErr)
	// Release the process lock only after the pools close, so a successor can
	// rely on this process being done writing.
	if d.lockRelease != nil {
		d.lockRelease()
		d.lockRelease = nil
	}
	return err
}

// Closed reports whether Close has been called on this handle.
func (d *DB) Closed() bool {
	return d.closed.Load()
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
// access, such as the writer's pool statistics.
func (d *DB) SQLDb() *sql.DB {
	return d.writer
}

// SQLReaderDB returns the underlying reader *sql.DB, so metrics can report
// reader-pool wait stats; for in-memory databases it is the writer.
func (d *DB) SQLReaderDB() *sql.DB {
	return d.reader
}

// PingRead answers whether the database can serve reads, via a bounded
// SELECT 1 on the reader pool. Pinging the single-connection writer would
// queue behind any long write and report a read-serving server as degraded;
// writer saturation is reported separately as a capacity signal.
func (d *DB) PingRead(ctx context.Context) error {
	var one int
	return d.reader.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}
