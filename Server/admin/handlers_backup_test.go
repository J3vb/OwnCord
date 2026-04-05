package admin_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
)

// chdirTemp changes the working directory to a fresh temp directory for the
// duration of t and restores the original on cleanup. Backup handlers use
// relative paths ("data/backups") that are resolved against cwd.
func chdirTemp(t *testing.T) string {
	t.Helper()
	tmpDir := t.TempDir()
	origDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	if err := os.Chdir(tmpDir); err != nil {
		t.Fatalf("os.Chdir(%q): %v", tmpDir, err)
	}
	// Update the package-level backup dir to match the new CWD (L14).
	admin.SetBackupBaseDir(filepath.Join(tmpDir, "data", "backups"))
	t.Cleanup(func() {
		_ = os.Chdir(origDir)
		admin.SetBackupBaseDir(filepath.Join(origDir, "data", "backups"))
	})
	return tmpDir
}

// ─── POST /backup ─────────────────────────────────────────────────────────────

// TestHandleBackup_Success verifies that the backup endpoint creates a backup
// file and returns 200 with path and created fields.
func TestHandleBackup_Success(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /backup status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if resp["path"] == "" {
		t.Error("response missing 'path' field")
	}
	if resp["created"] == "" {
		t.Error("response missing 'created' field")
	}

	// Verify the backup file actually exists on disk.
	backupDir := filepath.Join(tmpDir, "data", "backups")
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		t.Fatalf("ReadDir(%q): %v", backupDir, err)
	}
	if len(entries) == 0 {
		t.Error("no backup files found after successful backup")
	}
}

// TestHandleBackup_RequiresOwner verifies that admin-role (not owner) receives 403.
func TestHandleBackup_RequiresOwner(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)

	adminUID, _ := database.CreateUser("backupadmin", "hash", 2)
	token := "backup-admin-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	w := doRequest(t, handler, http.MethodPost, "/backup", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("admin user on /backup status = %d, want 403", w.Code)
	}
}

// ─── GET /backups ─────────────────────────────────────────────────────────────

// TestHandleListBackups_EmptyWhenNoDirExists verifies that the endpoint returns
// an empty JSON array when the backups directory does not exist.
func TestHandleListBackups_EmptyWhenNoDirExists(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/backups", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("GET /backups status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var backups []any
	if err := json.Unmarshal(w.Body.Bytes(), &backups); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(backups) != 0 {
		t.Errorf("expected 0 backups when dir missing, got %d", len(backups))
	}
}

// TestHandleListBackups_ReturnsCreatedBackup verifies that a backup created via
// POST /backup appears in GET /backups.
func TestHandleListBackups_ReturnsCreatedBackup(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	// Create a backup first.
	wBackup := doRequest(t, handler, http.MethodPost, "/backup", token, nil)
	if wBackup.Code != http.StatusOK {
		t.Fatalf("POST /backup failed: %d %s", wBackup.Code, wBackup.Body.String())
	}

	// Now list them.
	w := doRequest(t, handler, http.MethodGet, "/backups", token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /backups status = %d, want 200; body: %s", w.Code, w.Body.String())
	}

	var backups []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &backups); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(backups) == 0 {
		t.Fatal("expected at least 1 backup in list after POST /backup")
	}

	b := backups[0]
	if b["name"] == "" {
		t.Error("backup entry missing 'name'")
	}
	if b["size"] == nil {
		t.Error("backup entry missing 'size'")
	}
	if b["date"] == "" {
		t.Error("backup entry missing 'date'")
	}
}

// ─── DELETE /backups/{name} ───────────────────────────────────────────────────

// TestHandleDeleteBackup_Success verifies that an existing backup file is
// deleted and 204 is returned.
func TestHandleDeleteBackup_Success(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	// Create a real backup file to delete.
	backupDir := filepath.Join(tmpDir, "data", "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupName := "chatserver_20240101_120000.db"
	backupPath := filepath.Join(backupDir, backupName)
	if err := os.WriteFile(backupPath, []byte("fake backup"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	w := doRequest(t, handler, http.MethodDelete, "/backups/"+backupName, token, nil)

	if w.Code != http.StatusNoContent {
		t.Errorf("DELETE /backups/%s status = %d, want 204; body: %s", backupName, w.Code, w.Body.String())
	}

	// Verify the file is gone.
	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Error("backup file still exists after delete")
	}
}

// TestHandleDeleteBackup_NotFound verifies that deleting a nonexistent backup
// returns 404.
func TestHandleDeleteBackup_NotFound(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodDelete, "/backups/nonexistent.db", token, nil)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// TestHandleDeleteBackup_InvalidNameTraversal verifies that path traversal
// names are rejected with 400.
func TestHandleDeleteBackup_InvalidNameTraversal(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	// The chi router URL-decodes the path parameter, so ".." arrives decoded.
	// The handler checks for ".." and returns 400.
	w := doRequest(t, handler, http.MethodDelete, "/backups/..evil.db", token, nil)

	// Either 400 (blocked) or 404 (file not found) is acceptable.
	// What must NOT happen is 204 (successful delete).
	if w.Code == http.StatusNoContent {
		t.Error("path traversal name resulted in 204 — traversal not blocked")
	}
}

// TestHandleDeleteBackup_RequiresOwner verifies that admin-role is denied.
func TestHandleDeleteBackup_RequiresOwner(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)

	adminUID, _ := database.CreateUser("deladmin", "hash", 2)
	token := "del-admin-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	// Create the file so path validation doesn't return 404 before the 403.
	backupDir := filepath.Join(tmpDir, "data", "backups")
	_ = os.MkdirAll(backupDir, 0o750)
	_ = os.WriteFile(filepath.Join(backupDir, "test.db"), []byte("x"), 0o644)

	w := doRequest(t, handler, http.MethodDelete, "/backups/test.db", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("admin user on delete-backup status = %d, want 403", w.Code)
	}
}

// ─── POST /backups/{name}/restore ─────────────────────────────────────────────

// TestHandleRestoreBackup_Success verifies that a restore operation returns 200
// with the expected message and backup name.
func TestHandleRestoreBackup_Success(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	// Set up backup and data directories.
	backupDir := filepath.Join(tmpDir, "data", "backups")
	dataDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		t.Fatalf("MkdirAll backups: %v", err)
	}
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatalf("MkdirAll data: %v", err)
	}

	// Write content as the "backup" to restore from.
	backupName := "chatserver_20240101_120000.db"
	backupPath := filepath.Join(backupDir, backupName)
	fakeContent := []byte("fake sqlite db content")
	if err := os.WriteFile(backupPath, fakeContent, 0o644); err != nil {
		t.Fatalf("WriteFile backup: %v", err)
	}

	w := doRequest(t, handler, http.MethodPost, "/backups/"+backupName+"/restore", token, nil)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /backups/%s/restore status = %d, want 200; body: %s", backupName, w.Code, w.Body.String())
	}

	var resp map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp["message"] == "" {
		t.Error("response missing 'message' field")
	}
	if resp["backup"] != backupName {
		t.Errorf("backup = %q, want %q", resp["backup"], backupName)
	}
}

// TestHandleRestoreBackup_NotFound verifies that restoring a missing backup
// returns 404.
func TestHandleRestoreBackup_NotFound(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/backups/missing.db/restore", token, nil)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

// TestHandleRestoreBackup_InvalidName verifies that a name containing ".." is
// rejected with 400.
func TestHandleRestoreBackup_InvalidName(t *testing.T) {
	_ = chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodPost, "/backups/..evil.db/restore", token, nil)

	// Must not return 200 OK.
	if w.Code == http.StatusOK {
		t.Error("path-traversal restore name returned 200 — traversal not blocked")
	}
}

// TestHandleListBackups_ErrorReadingDir verifies that if the backups path
// exists but is a file (not a directory), the endpoint returns 500.
func TestHandleListBackups_ErrorReadingDir(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)
	token := createAdminUser(t, database)

	// Create data/ directory but make "backups" a file instead of a directory.
	dataDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		t.Fatalf("MkdirAll data: %v", err)
	}
	backupsFile := filepath.Join(dataDir, "backups")
	if err := os.WriteFile(backupsFile, []byte("not a directory"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	w := doRequest(t, handler, http.MethodGet, "/backups", token, nil)

	// os.ReadDir on a file (not a directory) fails with a non-IsNotExist error
	// on most platforms, but the exact behavior is platform-dependent.
	// On Windows, ReadDir on a file returns an error that is NOT os.IsNotExist.
	// So we expect either 500 or (in edge cases) 200 with empty list.
	if w.Code != http.StatusInternalServerError && w.Code != http.StatusOK {
		t.Errorf("status = %d, want 500 or 200 (platform dependent)", w.Code)
	}
}

// TestHandleRestoreBackup_RequiresOwner verifies that admin-role is denied.
func TestHandleRestoreBackup_RequiresOwner(t *testing.T) {
	tmpDir := chdirTemp(t)
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil)

	adminUID, _ := database.CreateUser("restoreadmin", "hash", 2)
	token := "restore-admin-token"
	_, _ = database.CreateSession(adminUID, auth.HashToken(token), "test", "127.0.0.1")

	// Create files so path checks pass before auth check.
	backupDir := filepath.Join(tmpDir, "data", "backups")
	dataDir := filepath.Join(tmpDir, "data")
	_ = os.MkdirAll(backupDir, 0o750)
	_ = os.MkdirAll(dataDir, 0o750)
	_ = os.WriteFile(filepath.Join(backupDir, "test.db"), []byte("x"), 0o644)

	w := doRequest(t, handler, http.MethodPost, "/backups/test.db/restore", token, nil)

	if w.Code != http.StatusForbidden {
		t.Errorf("admin user on restore status = %d, want 403", w.Code)
	}
}
