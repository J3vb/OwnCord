package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestConfigOverridesSensitive_BackupDirMayNotBeTheDatabaseFolder(t *testing.T) {
	f := newSensitiveFixture(t, `["192.0.2.0/24"]`, "")
	token := createAdminUser(t, f.database)
	w := patchConfig(t, f.handler, token, map[string]any{"backup.dir": f.dataDir}, []string{"backup.dir"}, "")
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "folder that holds the database") {
		t.Errorf("PATCH backup.dir to the database folder = %d %s, want 400 naming the database folder", w.Code, w.Body.String())
	}
	if len(savedOverrides(t, f.dataDir)) != 0 {
		t.Errorf("a refused backup.dir was saved")
	}
}

type liveDBFixture struct {
	dir     string
	dbFile  string
	handler http.Handler
	token   string
}

// newLiveDBFixture points backup.dir at the folder that holds the live database file, the way a hand-edited
// config.yaml can.
func newLiveDBFixture(t *testing.T) liveDBFixture {
	t.Helper()
	dir := t.TempDir()
	dbFile := filepath.Join(dir, "chatserver.db")
	if err := os.WriteFile(dbFile, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dbFile+"-wal", []byte("wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	cfg := &config.Config{Server: config.ServerConfig{DataDir: dir}, Backup: config.BackupConfig{Dir: dir}}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: filepath.Join(dir, "config.yaml"), RunningCfg: cfg, BackupDir: dir, DatabasePath: dbFile})
	return liveDBFixture{dir: dir, dbFile: dbFile, handler: handler, token: createAdminUser(t, database)}
}

func TestScanBackups_SkipsLiveDatabase(t *testing.T) {
	f := newLiveDBFixture(t)
	if newest, err := admin.NewestBackup(f.dir, f.dbFile); err != nil || !newest.IsZero() {
		t.Fatalf("NewestBackup = %v, %v; the live database must not count as a backup", newest, err)
	}

	real := filepath.Join(f.dir, "chatserver_20260101_000000.db")
	if err := os.WriteFile(real, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(real, ts, ts); err != nil {
		t.Fatal(err)
	}
	newest, err := admin.NewestBackup(f.dir, f.dbFile)
	if err != nil || newest.Sub(ts).Abs() > time.Second {
		t.Errorf("NewestBackup = %v, %v, want the real backup's time %v", newest, err, ts)
	}
}

func TestMaintainBackups_NeverPrunesLiveDatabase(t *testing.T) {
	f := newLiveDBFixture(t)
	old := time.Now().Add(-400 * 24 * time.Hour)
	if err := os.Chtimes(f.dbFile, old, old); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	settings := service.NewSettingsService(database)
	ctx := context.Background()
	mustSetSetting(t, database, "backup_retention", "7")
	mustSetSetting(t, database, "backup_schedule", "off")
	if err := admin.MaintainBackups(ctx, database, settings, f.dir, f.dbFile); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	if _, err := os.Stat(f.dbFile); err != nil {
		t.Errorf("live database was pruned: %v", err)
	}
}

func TestBackupHandlers_RefuseLiveDatabase(t *testing.T) {
	f := newLiveDBFixture(t)

	w := doRequest(t, f.handler, http.MethodGet, "/backups", f.token, nil)
	expectStatus(t, w, http.StatusOK)
	var listed []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed) != 0 {
		t.Errorf("list shows the live database: %v", listed)
	}

	for _, name := range []string{"chatserver.db", "chatserver.db-wal"} {
		w = doRequest(t, f.handler, http.MethodDelete, "/backups/"+name, f.token, nil)
		expectStatus(t, w, http.StatusBadRequest)
		if _, err := os.Stat(filepath.Join(f.dir, name)); err != nil {
			t.Errorf("DELETE %s removed the live file: %v", name, err)
		}
	}
	w = doRequest(t, f.handler, http.MethodPost, "/backups/chatserver.db/restore", f.token, nil)
	expectStatus(t, w, http.StatusBadRequest)
	w = doRequest(t, f.handler, http.MethodPost, "/backups/chatserver.db/link", f.token, nil)
	expectStatus(t, w, http.StatusBadRequest)
}
