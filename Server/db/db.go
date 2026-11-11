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

// DB wraps the SQLite reader and writer pools; queries delegate to the sqlc layer (db/dbgen).
type DB struct {
	// writer is a single-connection pool owning every statement that can mutate
	// the database, so concurrent writers queue in Go instead of colliding on
	// SQLite's write lock.
	writer *sql.DB

	// reader is a multi-connection pool for read-only statements; it is the same
	// handle as writer for in-memory databases.
	reader *sql.DB

	q *dbgen.Queries

	readStmts readStmtCache

	// auditWriter, when installed via SetAuditWriter (startup only), makes
	// WriteAudit non-blocking; nil keeps it synchronous, which the token CLI and tests rely on.
	auditWriter atomic.Pointer[AuditWriter]

	messageDeliveryFloor atomic.Int64

	// attachmentBytesCache and activeMessagesCache hold the whole-table aggregates
	// the metrics scrape and admin stats read.
	attachmentBytesCache syncutil.TTLCache[int64]
	activeMessagesCache  syncutil.TTLCache[int64]

	// closed is set by Close; a backup restore closes the handle while the
	// lifecycle is still up.
	closed atomic.Bool

	// plainMemory is true for a private ":memory:" database, the only kind Migrate
	// may fill from the cached migrated image (migrate_memory.go).
	plainMemory bool

	walPath string

	// backupSpace is what BackupToSafe checks free space against; nil means no
	// reserve and diskutil.FreeBytes (backup_space.go).
	backupSpace atomic.Pointer[backupSpace]

	// lockRelease drops the single-process advisory lock taken by openFile; nil
	// in memory or when locking is unavailable.
	lockRelease func()

	// acceptGuardHook is a test seam inside AcceptMessageRequest's transaction,
	// after the pending check and before the write, so a test can race a
	// competing TransitionMessageRequest. Nil in production.
	acceptGuardHook func()

	// afterDMParticipantsInsertHook is a test seam in getOrCreateDMChannel's create
	// branch, after the participants insert, to prove the transaction rolls back. Nil in production.
	afterDMParticipantsInsertHook func() error

	// checkpointOwed records that an erasure's wal_checkpoint(TRUNCATE) came back
	// blocked or partial, so frames holding erased bytes are still in the -wal.
	// Process-local on purpose: a crash loses it, which is why the start-up pass
	// (CheckpointErasureWAL) runs unconditionally.
	checkpointOwed atomic.Bool

	checkpointAttempts atomic.Int64

	// testEraseCommitHook is a test seam called after eraseAccountTx commits and
	// before the wal_checkpoint(TRUNCATE). The writer connection is held, so the
	// hook must not touch this DB's pools. Nil in production.
	testEraseCommitHook  func()
	testErasureChunkHook func(stage string, n int) error
}

// filePragmas are the per-connection PRAGMAs in the DSN (busy_timeout first); an
// Exec'd PRAGMA would hit one arbitrary connection and leave foreign_keys=OFF on the
// others.
const filePragmas = "_pragma=busy_timeout(5000)" + // wait up to 5s for the write lock instead of failing instantly
	"&_pragma=journal_mode(WAL)" + // WAL: readers don't block the writer and vice versa
	"&_pragma=foreign_keys(1)" + // enforce foreign key constraints
	"&_pragma=synchronous(NORMAL)" + // performance tuning, safe with WAL
	"&_pragma=temp_store(MEMORY)" +
	"&_pragma=mmap_size(268435456)" +
	"&_pragma=cache_size(-64000)" +
	// Cap the WAL at 64 MiB so a restart truncates it instead of keeping the busiest hour's high-water mark.
	"&_pragma=journal_size_limit(67108864)"

func isMemoryPath(path string) bool {
	return strings.Contains(path, ":memory:") || strings.Contains(path, "mode=memory")
}

// Open opens (or creates) a SQLite database at path with WAL and foreign keys
// on. In-memory databases use one connection with the PRAGMAs Exec'd once, so
// reader and writer are the same handle. File-backed databases split reader
// and writer pools with the PRAGMAs in both DSNs; the writer uses
// _txlock=immediate so transactions take the write lock up front instead of
// failing with SQLITE_BUSY on upgrade. path must be a plain filesystem path or
// an existing file: URI without '?', '#' or '%', because it is embedded in a
// file: URI unescaped.
func Open(path string) (*DB, error) {
	return OpenWithMaxReaders(path, 0)
}

// OpenWithMaxReaders is Open with an explicit reader-pool bound
// (database.max_readers); <= 0 keeps automatic sizing, values clamp to [1, 64].
// Ignored in memory.
func OpenWithMaxReaders(path string, maxReaders int) (*DB, error) {
	if isMemoryPath(path) {
		return openMemory(path)
	}
	return openFile(path, maxReaders, true)
}

// defaultReaderConns is twice the CPU count with a floor of 8, clamped to
// [1, 64]; the floor matters on small hosts under a connect herd.
func defaultReaderConns(cpus int) int {
	return min(max(8, 2*cpus), 64)
}

// OpenShared opens the database without the single-process lock, for short-lived
// tooling (the `server token` CLI) that must work while the server runs. Long-lived
// processes must use Open.
func OpenShared(path string) (*DB, error) {
	if isMemoryPath(path) {
		return openMemory(path)
	}
	return openFile(path, 0, false)
}

func openMemory(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}

	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

	sqlDB.SetMaxOpenConns(1)

	if err := applyMemoryPragmas(sqlDB); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}

	d := newDB(sqlDB, sqlDB)
	d.plainMemory = path == ":memory:"
	return d, nil
}

// openFile opens the pools for a file-backed database; takeLock is false only for OpenShared.
func openFile(path string, maxReaders int, takeLock bool) (*DB, error) {
	// Presence, the replay ring, rate-limit windows and the boot-time status
	// reset are process-local and assume one server owns this file, so a second
	// process fails fast.
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
			// The lock mechanism itself failed (e.g. NFS rejecting advisory locks); SQLite still protects the file.
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

	writer, err := sql.Open("sqlite", dsn+"&_txlock=immediate")
	if err != nil {
		return nil, fmt.Errorf("opening sqlite db: %w", err)
	}
	writer.SetMaxOpenConns(1)

	// Ping the writer first: it creates the file, so the reader never races its creation.
	if err := writer.Ping(); err != nil {
		_ = writer.Close()
		return nil, fmt.Errorf("pinging sqlite db: %w", err)
	}

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

func newDB(writer, reader *sql.DB) *DB {
	d := &DB{writer: writer, reader: reader}
	d.q = dbgen.New(&dbtx{writer: writer, reader: reader, stmts: &d.readStmts})
	return d
}

// Migrate runs all embedded SQL migrations in order, each once, via MigrateFS. An
// empty in-memory database gets a copy of the cached migrated image
// (migrate_memory.go).
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
	// Refresh planner statistics when the schema changed. A full ANALYZE grows
	// with row count and blocks startup, so unchanged schemas get the cheap PRAGMA
	// optimize; both write sqlite_stat rows, so they run on the writer.
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
	_, _ = d.writer.Exec("PRAGMA optimize;")
	var readerErr error
	if d.reader != d.writer {
		readerErr = d.reader.Close()
	}
	writerErr := d.writer.Close()
	// Statements close after the pools: closing a pool wakes a cached query
	// waiting for a connection, which a statement Close would wait on.
	err := errors.Join(d.readStmts.close(), writerErr, readerErr)
	// Release the process lock only after the pools close, so a successor can rely on this process
	// being done writing.
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

// QueryRowContext runs read-only statements on the reader pool, others on the writer.
func (d *DB) QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row {
	return d.routePool(query).QueryRowContext(ctx, query, args...)
}

// ExecContext always runs on the writer.
func (d *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return d.writer.ExecContext(ctx, query, args...)
}

// QueryContext runs read-only statements on the reader pool, others on the writer.
func (d *DB) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	return d.routePool(query).QueryContext(ctx, query, args...)
}

func (d *DB) routePool(query string) *sql.DB {
	if isReadOnlySQL(query) {
		return d.reader
	}
	return d.writer
}

// BeginTx always runs on the writer (BEGIN IMMEDIATE via _txlock).
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	return d.writer.BeginTx(ctx, opts)
}

// SQLDb returns the writer *sql.DB, e.g. for pool statistics.
func (d *DB) SQLDb() *sql.DB {
	return d.writer
}

// SQLReaderDB returns the reader *sql.DB for wait stats; the writer for in-memory databases.
func (d *DB) SQLReaderDB() *sql.DB {
	return d.reader
}

// PingRead answers whether the database can serve reads via SELECT 1 on the reader
// pool; pinging the writer would queue behind a long write and misreport the server as
// degraded.
func (d *DB) PingRead(ctx context.Context) error {
	var one int
	return d.reader.QueryRowContext(ctx, "SELECT 1").Scan(&one)
}
