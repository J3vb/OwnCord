package admin_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/db"
)

const restoreFixtureRows = 50

type fileRestoreFixture struct {
	database   *db.DB
	hub        *mockHub
	handler    http.Handler
	token      string
	dbPath     string
	backupName string
}

// newFileRestoreFixture opens a file-backed (WAL) database at the configured
// path, fills a table with restoreFixtureRows rows and takes the backup the
// test restores. The in-memory database the other restore tests use has no
// WAL, so it cannot show what a restore does with one.
func newFileRestoreFixture(t *testing.T) fileRestoreFixture {
	t.Helper()
	tmpDir := chdirTemp(t)
	backupDir := filepath.Join(tmpDir, "data", "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		t.Fatalf("MkdirAll backups: %v", err)
	}
	dbPath := filepath.Join(tmpDir, "data", "chatserver.db")
	admin.SetDatabasePath(dbPath)
	t.Cleanup(func() { admin.SetDatabasePath(filepath.Join("data", "chatserver.db")) })

	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() {
		if !database.Closed() {
			_ = database.Close()
		}
	})
	if err := db.MigrateFS(database, fstest.MapFS{"001_initial_schema.sql": {Data: adminSchema}}); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	hub := &mockHub{}
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, nil, newTestServices(database))
	token := createAdminUser(t, database)

	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `CREATE TABLE restore_rows (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`); err != nil {
		t.Fatalf("create restore_rows: %v", err)
	}
	for i := range restoreFixtureRows {
		if _, err := database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES (?)`, fmt.Sprintf("backup-%d", i)); err != nil {
			t.Fatalf("insert fixture row: %v", err)
		}
	}
	backupName := "chatserver_20240105_120000.db"
	if err := database.BackupToSafe(ctx, filepath.Join(backupDir, backupName), backupDir); err != nil {
		t.Fatalf("BackupToSafe fixture: %v", err)
	}
	return fileRestoreFixture{database: database, hub: hub, handler: handler, token: token, dbPath: dbPath, backupName: backupName}
}

// holdReadTx opens a read transaction on the reader pool after at least one
// frame is in the log and leaves the log longer than the reader's snapshot,
// so a wal_checkpoint(TRUNCATE) cannot finish while it is held.
func holdReadTx(t *testing.T, database *db.DB) (release func()) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES ('before-reader')`); err != nil {
		t.Fatalf("insert before reader: %v", err)
	}
	conn, err := database.SQLReaderDB().Conn(ctx)
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("reader begin: %v", err)
	}
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM restore_rows`).Scan(&n); err != nil {
		t.Fatalf("reader select: %v", err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES ('after-reader')`); err != nil {
		t.Fatalf("insert after reader: %v", err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = tx.Rollback()
			_ = conn.Close()
		})
	}
}

// staleWAL returns the bytes of a valid write-ahead log from another database
// with the same table, as a crashed or uncheckpointed close leaves one behind.
// SQLite replays a log like this onto whatever main file sits beside it.
func staleWAL(t *testing.T) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "other.db")
	other, err := db.Open(path)
	if err != nil {
		t.Fatalf("db.Open other: %v", err)
	}
	defer other.Close() //nolint:errcheck
	ctx := context.Background()
	if _, err := other.ExecContext(ctx, `CREATE TABLE restore_rows (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`); err != nil {
		t.Fatalf("create other table: %v", err)
	}
	for i := range 5 {
		if _, err := other.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES (?)`, fmt.Sprintf("stale-%d", i)); err != nil {
			t.Fatalf("insert other row: %v", err)
		}
	}
	wal, err := os.ReadFile(path + "-wal")
	if err != nil {
		t.Fatalf("read other WAL: %v", err)
	}
	if len(wal) == 0 {
		t.Fatal("other database left an empty WAL; the fixture needs frames in it")
	}
	return wal
}

func waitRestarted(t *testing.T, restarted func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !restarted() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	return restarted()
}

// TestHandleRestoreBackup_RefusesWhenCheckpointBusy: a reader that keeps the
// write-ahead log from being emptied makes the restore refuse before anything
// is closed, broadcast or restarted.
func TestHandleRestoreBackup_RefusesWhenCheckpointBusy(t *testing.T) {
	f := newFileRestoreFixture(t)
	// The writer's busy wait bounds how long the checkpoint waits for the
	// reader; keep it short so the refusal does not take the default 5s.
	if _, err := f.database.SQLDb().Exec(`PRAGMA busy_timeout=200`); err != nil {
		t.Fatalf("busy_timeout: %v", err)
	}
	release := holdReadTx(t, f.database)
	defer release()

	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body.String())
	}
	release()

	if f.database.Closed() {
		t.Error("a refused restore closed the live database")
	}
	if len(f.hub.restartCalls) != 0 {
		t.Errorf("a refused restore broadcast %d restart notice(s); clients would wait for a restart that never comes", len(f.hub.restartCalls))
	}
	time.Sleep(50 * time.Millisecond)
	if restarted() {
		t.Error("a refused restore requested a process restart")
	}
	var n int
	if err := f.database.QueryRowContext(context.Background(), `SELECT count(*) FROM restore_rows`).Scan(&n); err != nil {
		t.Fatalf("count after refusal: %v", err)
	}
	if want := restoreFixtureRows + 2; n != want {
		t.Errorf("rows after a refused restore = %d, want %d (the live data must be untouched)", n, want)
	}
}

// TestHandleRestoreBackup_UnderLoadLeavesNoStaleWAL restores while writers
// keep writing and a reader briefly holds a snapshot, with a stale log left
// beside the file after the pools close. The reopened database must be the
// backup: integrity ok, the backup's rows, and no sidecar left to replay.
func TestHandleRestoreBackup_UnderLoadLeavesNoStaleWAL(t *testing.T) {
	f := newFileRestoreFixture(t)
	stale := staleWAL(t)

	release := holdReadTx(t, f.database)
	defer release()
	releaseTimer := time.AfterFunc(300*time.Millisecond, release)
	defer releaseTimer.Stop()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var writers sync.WaitGroup
	for w := range 4 {
		writers.Add(1)
		go func(ctx context.Context) {
			defer writers.Done()
			for i := 0; ctx.Err() == nil; i++ {
				if _, err := f.database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES (?)`, fmt.Sprintf("w%d-%d", w, i)); err != nil {
					return
				}
			}
		}(ctx)
	}

	closeHook := admin.StubCloser(func(database *db.DB) error {
		err := admin.CloseDatabaseForTest(database)
		// Plant the log once no connection is left that could checkpoint
		// or delete it on its way out, as a close that could not finish
		// its own checkpoint leaves one.
		waitCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if werr := database.WaitConnsClosed(waitCtx); werr != nil {
			t.Errorf("connections did not close: %v", werr)
		}
		if werr := os.WriteFile(f.dbPath+"-wal", stale, 0o600); werr != nil {
			t.Errorf("plant stale WAL: %v", werr)
		}
		return err
	})
	defer closeHook()
	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	cancel()
	writers.Wait()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if !waitRestarted(t, restarted) {
		t.Error("restore did not request a restart")
	}

	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(f.dbPath + suffix); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s is still beside the restored file (stat err %v); the next open would replay it", filepath.Base(f.dbPath+suffix), err)
		}
	}

	if err := db.CheckBackupIntegrity(context.Background(), f.dbPath); err != nil {
		t.Fatalf("restored database integrity: %v", err)
	}
	reopened, err := db.Open(f.dbPath)
	if err != nil {
		t.Fatalf("reopen restored database: %v", err)
	}
	defer reopened.Close() //nolint:errcheck
	var n int
	if err := reopened.QueryRowContext(context.Background(), `SELECT count(*) FROM restore_rows`).Scan(&n); err != nil {
		t.Fatalf("count restored rows: %v", err)
	}
	if n != restoreFixtureRows {
		t.Errorf("restored rows = %d, want the backup's %d", n, restoreFixtureRows)
	}
}

// TestHandleRestoreBackup_CopiesOnlyAfterEveryConnectionCloses: Close leaves a
// connection that is in use open until it is released, and the last SQLite
// connection to close checkpoints into the main file. The copy must wait for it.
func TestHandleRestoreBackup_CopiesOnlyAfterEveryConnectionCloses(t *testing.T) {
	f := newFileRestoreFixture(t)
	conn, err := f.database.SQLReaderDB().Conn(context.Background())
	if err != nil {
		t.Fatalf("reader conn: %v", err)
	}
	releaseTimer := time.AfterFunc(300*time.Millisecond, func() { _ = conn.Close() })
	defer releaseTimer.Stop()

	openAtCopy := -1
	copyHook := admin.StubCopyBackup(func(src, dst string) error {
		openAtCopy = f.database.SQLDb().Stats().OpenConnections + f.database.SQLReaderDB().Stats().OpenConnections
		return admin.CopyBackupForTest(src, dst)
	})
	defer copyHook()
	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if openAtCopy != 0 {
		t.Errorf("%d database connection(s) were still open when the backup was copied in", openAtCopy)
	}
	if !waitRestarted(t, restarted) {
		t.Error("restore did not request a restart")
	}
}
