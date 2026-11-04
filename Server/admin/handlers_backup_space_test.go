package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

func decodeAdminErr(t *testing.T, body []byte) (code, message string) {
	t.Helper()
	var resp struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode error body %q: %v", body, err)
	}
	return resp.Error, resp.Message
}

func backupDirNames(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// 'Backup now' on a volume too short for the copy answers 507
// STORAGE_LOW_DISK with the numbers and leaves no file behind.
func TestHandleBackup_LowDiskAnswers507(t *testing.T) {
	f := newFileRestoreFixture(t)
	backupDir := filepath.Join(filepath.Dir(f.dbPath), "backups")
	before := backupDirNames(t, backupDir)
	f.database.SetBackupFreeBytesForTest(256<<20, func(string) (uint64, error) { return 100 << 20, nil })

	w := doRequest(t, f.handler, http.MethodPost, "/backup", f.token, nil)
	if w.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507; body: %s", w.Code, w.Body.String())
	}
	code, msg := decodeAdminErr(t, w.Body.Bytes())
	if code != string(httperr.CodeStorageLowDisk) {
		t.Errorf("code = %q, want %q", code, httperr.CodeStorageLowDisk)
	}
	for _, want := range []string{"backup failed: not enough free disk space", "100 MB is free", "server.min_free_disk_mb"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q does not say %q", msg, want)
		}
	}
	if after := backupDirNames(t, backupDir); !slices.Equal(after, before) {
		t.Errorf("backup dir changed on a refused backup: %v -> %v", before, after)
	}
}

// A restore whose safety copy does not fit is aborted with 507 and the live
// database untouched.
func TestHandleRestoreBackup_LowDiskAbortsWith507(t *testing.T) {
	f := newFileRestoreFixture(t)
	restarted, restoreHook := admin.StubRestart()
	defer restoreHook()
	f.database.SetBackupFreeBytesForTest(256<<20, func(string) (uint64, error) { return 1 << 20, nil })

	w := doRequest(t, f.handler, http.MethodPost, "/backups/"+f.backupName+"/restore", f.token, nil)
	if w.Code != http.StatusInsufficientStorage {
		t.Fatalf("status = %d, want 507; body: %s", w.Code, w.Body.String())
	}
	code, msg := decodeAdminErr(t, w.Body.Bytes())
	if code != string(httperr.CodeStorageLowDisk) || !strings.Contains(msg, "restore aborted, database untouched") || !strings.Contains(msg, "1 MB is free") {
		t.Errorf("answer = %q %q, want STORAGE_LOW_DISK naming the abort and the numbers", code, msg)
	}
	if restarted() {
		t.Error("a refused restore must not restart the process")
	}
	if _, err := os.Stat(f.dbPath + ".restore-staged"); err == nil {
		t.Error("a refused restore staged a database")
	}
}

// Right after 'Backup now' the attention panel's backup signal reports the
// new backup instead of waiting for the next minute's sample.
func TestHandleBackup_RefreshesTheAttentionSignal(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	backupDir := filepath.Join(tmpDir, "data", "backups")
	svc := newTestServices(database)
	svc.Attention = service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{
		BackupSchedule: func(context.Context) (string, error) { return "daily", nil },
		LastBackup:     func() (time.Time, error) { return admin.NewestBackup(backupDir) },
	})
	svc.Attention.Evaluate(context.Background(), time.Now())
	backupStatus := func() string {
		for _, s := range svc.Attention.Report().Signals {
			if s.ID == "backup" {
				return s.Status
			}
		}
		t.Fatal("no backup signal")
		return ""
	}
	if got := backupStatus(); got != service.AttentionStatusUnknown {
		t.Fatalf("backup signal before any backup = %q, want unknown", got)
	}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)
	token := createAdminUser(t, database)

	if w := doRequest(t, handler, http.MethodPost, "/backup", token, nil); w.Code != http.StatusOK {
		t.Fatalf("POST /backup status = %d; body: %s", w.Code, w.Body.String())
	}
	if got := backupStatus(); got != service.AttentionStatusOK {
		t.Fatalf("backup signal right after 'Backup now' = %q, want ok", got)
	}
}
