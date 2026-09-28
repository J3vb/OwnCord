package admin_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// archiveFixture lays out a realistic data directory + config.yaml, points the
// admin package at them, and returns the handler and an owner token.
type archiveFixture struct {
	dir      string
	dataDir  string
	config   string
	handler  http.Handler
	database *db.DB
	token    string
}

func newArchiveFixture(t *testing.T) archiveFixture {
	t.Helper()
	dir := t.TempDir()
	dataDir := filepath.Join(dir, "data")
	uploads := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploads, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploads, "hello.bin"), []byte("attachment bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "totp.key"), []byte("totp-key-material"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte("server:\n  port: 8443\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A backup inside the data dir must not be mistaken for the live database.
	if err := os.MkdirAll(filepath.Join(dataDir, "backups"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "backups", "old.db"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	database := openAdminTestDB(t)
	dbPath := filepath.Join(dataDir, "chatserver.db")
	admin.SetDatabasePath(dbPath)
	t.Cleanup(func() { admin.SetDatabasePath(filepath.Join("data", "chatserver.db")) })

	cfg := &config.Config{Server: config.ServerConfig{DataDir: dataDir}, Upload: config.UploadConfig{StorageDir: uploads}}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: configPath, RunningCfg: cfg})
	token := createAdminUser(t, database)
	return archiveFixture{dir: dir, dataDir: dataDir, config: configPath, handler: handler, database: database, token: token}
}

// archiveEntries fetches GET /archive and returns the zip's members by name.
func archiveEntries(t *testing.T, f archiveFixture) map[string][]byte {
	t.Helper()
	w := doRequest(t, f.handler, http.MethodGet, "/archive", f.token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /archive = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
		t.Errorf("Content-Type = %q, want application/zip", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); cd == "" || !bytes.Contains([]byte(cd), []byte("owncord-archive")) {
		t.Errorf("Content-Disposition = %q, want an owncord-archive attachment", cd)
	}
	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("zip.NewReader: %v", err)
	}
	out := map[string][]byte{}
	for _, zf := range zr.File {
		rc, err := zf.Open()
		if err != nil {
			t.Fatalf("open %s: %v", zf.Name, err)
		}
		data, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", zf.Name, err)
		}
		out[zf.Name] = data
	}
	return out
}

// TestHandleArchive_Success is O3's owner download: one zip carrying the
// database (a verified, consistent snapshot), uploads, the key files and
// config.yaml, so an owner has the whole of what a restore needs.
func TestHandleArchive_Success(t *testing.T) {
	f := newArchiveFixture(t)
	entries := archiveEntries(t, f)

	for _, want := range []string{"data/chatserver.db", "data/uploads/hello.bin", "data/totp.key", "config.yaml"} {
		if _, ok := entries[want]; !ok {
			t.Errorf("archive is missing %q; got %v", want, archiveNames(entries))
		}
	}
	if got := string(entries["data/uploads/hello.bin"]); got != "attachment bytes" {
		t.Errorf("uploads entry = %q, want the attachment bytes", got)
	}

	// The database entry must be a consistent, readable snapshot — a raw copy
	// of a WAL-mode file while the server runs would not be.
	dbEntry, ok := entries["data/chatserver.db"]
	if !ok {
		t.Fatal("no database entry to verify")
	}
	path := filepath.Join(t.TempDir(), "snapshot.db")
	if err := os.WriteFile(path, dbEntry, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := db.CheckBackupIntegrity(t.Context(), path); err != nil {
		t.Fatalf("archived database failed integrity_check: %v", err)
	}
}

// TestHandleArchive_ConfigMissingStillArchives: the archive is the recovery
// path, so an absent config.yaml must not fail it — the operator still gets
// the data directory.
func TestHandleArchive_ConfigMissingStillArchives(t *testing.T) {
	f := newArchiveFixture(t)
	if err := os.Remove(f.config); err != nil {
		t.Fatal(err)
	}
	entries := archiveEntries(t, f)
	if _, ok := entries["data/chatserver.db"]; !ok {
		t.Errorf("archive missing the database entry after config removal; got %v", archiveNames(entries))
	}
	if _, ok := entries["config.yaml"]; ok {
		t.Error("archive carries a config.yaml that does not exist on disk")
	}
}

// TestHandleArchive_RequiresOwner: the archive holds password hashes and the
// key files, so only the Owner may download it.
func TestHandleArchive_RequiresOwner(t *testing.T) {
	f := newArchiveFixture(t)
	_, modToken := createRoleUser(t, f.database, 22, "Moderator", permissions.KickMembers, 40, "archivemod")
	if w := doRequest(t, f.handler, http.MethodGet, "/archive", modToken, nil); w.Code != http.StatusForbidden {
		t.Errorf("moderator GET /archive = %d, want 403; body: %s", w.Code, w.Body.String())
	}
}

// TestHandleArchive_BadDataDirIs500: a failure before any body is written
// must be a clean 500, not a truncated zip the browser saves as corrupt. A
// data dir under a regular file can never be walked.
func TestHandleArchive_BadDataDirIs500(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := openAdminTestDB(t)
	admin.SetDatabasePath(filepath.Join(dir, "chatserver.db"))
	t.Cleanup(func() { admin.SetDatabasePath(filepath.Join("data", "chatserver.db")) })
	cfg := &config.Config{Server: config.ServerConfig{DataDir: filepath.Join(blocker, "nope")}}
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: filepath.Join(dir, "config.yaml"), RunningCfg: cfg})
	token := createAdminUser(t, database)

	w := doRequest(t, handler, http.MethodGet, "/archive", token, nil)
	if w.Code != http.StatusInternalServerError {
		t.Errorf("GET /archive with an unwalkable data dir = %d, want 500", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Errorf("error body is not JSON: %s", w.Body.String())
	}
}

func archiveNames(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
