package admin_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

func waitRestarted(t *testing.T, restarted func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !restarted() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	return restarted()
}

// TestHandleRestoreBackup_CarriesTheLiveSeqFloor: the live settings.ws_seq_floor
// reaches the sidecar before the restore is staged (the backup was taken before
// the floor was set).
func TestHandleRestoreBackup_CarriesTheLiveSeqFloor(t *testing.T) {
	f := newFileRestoreFixture(t)
	if err := f.database.SetSetting(context.Background(), db.WSSeqFloorSettingKey, "5000000000"); err != nil {
		t.Fatal(err)
	}
	_, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body.String())
	}
	read := func() string {
		b, err := os.ReadFile(f.dbPath + ".ws-seq-floor")
		if err != nil {
			t.Fatalf("sidecar: %v", err)
		}
		return string(b)
	}
	if got := read(); got != "5000000000\n" {
		t.Fatalf("sidecar = %q, want the live floor", got)
	}
}

// TestHandleRestoreBackup_RefusesWhenTheSeqFloorCannotBeStored: with the live
// floor unable to reach the sidecar, the backup must not replace the database.
func TestHandleRestoreBackup_RefusesWhenTheSeqFloorCannotBeStored(t *testing.T) {
	f := newFileRestoreFixture(t)
	if err := f.database.SetSetting(context.Background(), db.WSSeqFloorSettingKey, "5000000000"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.dbPath+".ws-seq-floor", 0o700); err != nil {
		t.Fatal(err)
	}
	_, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body: %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(f.dbPath + ".restore-pending.json"); err == nil {
		t.Error("a refused restore left a marker")
	}
	got, err := f.database.GetSetting(context.Background(), db.WSSeqFloorSettingKey)
	if err != nil || got != "5000000000" {
		t.Errorf("live floor = %q, %v; the refused restore must leave the live database in place", got, err)
	}
}

func countRestoreRows(t *testing.T, database *db.DB) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT count(*) FROM restore_rows`).Scan(&n); err != nil {
		t.Fatalf("count restore_rows: %v", err)
	}
	return n
}

// TestHandleRestoreBackup_StagesInsteadOfOverwriting: the request stages a
// verified copy and a marker beside the database and restarts. The open
// database is neither closed nor written, and the one server_restart notice
// is the restart coordinator's, not the handler's. The next boot's apply
// then serves the backup's rows with no sidecar left to replay.
func TestHandleRestoreBackup_StagesInsteadOfOverwriting(t *testing.T) {
	f := newFileRestoreFixture(t)
	ctx := context.Background()
	for i := range 5 {
		if _, err := f.database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES (?)`, fmt.Sprintf("after-backup-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()

	// Writers keep running across the request, as they would on a busy server.
	wctx, cancel := context.WithCancel(ctx)
	var writers sync.WaitGroup
	for w := range 3 {
		writers.Add(1)
		go func(ctx context.Context) {
			defer writers.Done()
			for i := 0; ctx.Err() == nil; i++ {
				if _, err := f.database.ExecContext(ctx, `INSERT INTO restore_rows (v) VALUES (?)`, fmt.Sprintf("w%d-%d", w, i)); err != nil {
					return
				}
				time.Sleep(time.Millisecond)
			}
		}(wctx)
	}

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	cancel()
	writers.Wait()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp["backup"] != f.backupName || resp["message"] != "restore staged — server restarting" {
		t.Errorf("response = %v", resp)
	}
	if !waitRestarted(t, restarted) {
		t.Error("restore did not request a restart")
	}
	if len(f.hub.restartCalls) != 0 {
		t.Errorf("handler broadcast %d restart notice(s); the restart coordinator sends the only one", len(f.hub.restartCalls))
	}
	if f.database.Closed() {
		t.Fatal("the handler closed the live database")
	}
	if n := countRestoreRows(t, f.database); n < restoreFixtureRows+5 {
		t.Errorf("live rows = %d; the request must not have touched the live data", n)
	}
	for _, suffix := range []string{".restore-staged", ".restore-pending.json"} {
		if _, err := os.Stat(f.dbPath + suffix); err != nil {
			t.Errorf("%s was not written: %v", suffix, err)
		}
	}

	// The next boot: close, apply, reopen.
	if err := f.database.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := db.Open(f.dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reopened.Close() //nolint:errcheck
	if n := countRestoreRows(t, reopened); n != restoreFixtureRows {
		t.Errorf("rows after the boot-time apply = %d, want the backup's %d", n, restoreFixtureRows)
	}
	res, found, err := db.TakeRestoreResult(f.dbPath)
	if err != nil || !found || res.Status != db.RestoreStatusApplied || res.Backup != f.backupName {
		t.Errorf("restore result = %+v, %v, %v", res, found, err)
	}
	for _, suffix := range []string{".restore-staged", ".restore-pending.json", ".restore-rollback"} {
		if _, err := os.Stat(f.dbPath + suffix); err == nil {
			t.Errorf("%s survived the apply", suffix)
		}
	}
}

// TestHandleRestoreBackup_StageFailureLeavesDatabaseAndNoRestart: a copy that
// cannot be staged (here the staged name is occupied by a directory) answers
// 500, leaves the database serving, and does not restart.
func TestHandleRestoreBackup_StageFailureLeavesDatabaseAndNoRestart(t *testing.T) {
	f := newFileRestoreFixture(t)
	blocker := filepath.Join(f.dbPath+".restore-staged", "keep")
	if err := os.MkdirAll(filepath.Dir(blocker), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "could not stage the backup") {
		t.Errorf("body = %s", w.Body.String())
	}
	time.Sleep(50 * time.Millisecond)
	if restarted() {
		t.Error("a failed stage requested a restart")
	}
	if f.database.Closed() || countRestoreRows(t, f.database) != restoreFixtureRows {
		t.Error("a failed stage disturbed the live database")
	}
	if _, err := os.Stat(f.dbPath + ".restore-pending.json"); err == nil {
		t.Error("a marker was written for a failed stage")
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(f.dbPath), "backups"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre_restore_") {
			t.Errorf("a refused restore left its safety copy %s behind", e.Name())
		}
	}
	if admin.CurrentRestartState() == "pending" {
		t.Error("a failed stage left the restart guard pending")
	}
}
