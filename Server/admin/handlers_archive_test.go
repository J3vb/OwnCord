package admin_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
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

// newArchiveFixture builds the fixture; configure, when given, adjusts the
// running config before the handler is built.
func newArchiveFixture(t *testing.T, configure ...func(dir string, cfg *config.Config)) archiveFixture {
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
	// The backup dir and in-progress *.tmp files sit inside the data dir but
	// are not part of the archive.
	backups := filepath.Join(dataDir, "backups")
	if err := os.MkdirAll(backups, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(backups, "old.db"), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "snapshot.db.tmp"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}

	// The live database file and its WAL sidecars: junk, so only the
	// snapshot substitution can make the archived entry a valid database.
	dbPath := filepath.Join(dataDir, "chatserver.db")
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if err := os.WriteFile(p, []byte("not a database"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	database := openAdminTestDB(t)
	admin.SetDatabasePath(dbPath)
	t.Cleanup(func() { admin.SetDatabasePath(filepath.Join("data", "chatserver.db")) })

	cfg := &config.Config{
		Server: config.ServerConfig{DataDir: dataDir},
		Upload: config.UploadConfig{StorageDir: uploads},
		Backup: config.BackupConfig{Dir: backups},
	}
	for _, c := range configure {
		c(dir, cfg)
	}
	admin.SetBackupBaseDir(cfg.Backup.Dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{ConfigPath: configPath, RunningCfg: cfg})
	token := createAdminUser(t, database)
	return archiveFixture{dir: dir, dataDir: dataDir, config: configPath, handler: handler, database: database, token: token}
}

// archiveZip fetches GET /archive and opens the returned zip.
func archiveZip(t *testing.T, f archiveFixture) *zip.Reader {
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
	return zr
}

// archiveEntries fetches GET /archive and returns the zip's members by name.
func archiveEntries(t *testing.T, f archiveFixture) map[string][]byte {
	t.Helper()
	zr := archiveZip(t, f)
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
	for _, unwanted := range []string{
		"data/backups/", "data/backups/old.db", "data/snapshot.db.tmp",
		"data/chatserver.db-wal", "data/chatserver.db-shm",
	} {
		if _, ok := entries[unwanted]; ok {
			t.Errorf("archive carries %q; got %v", unwanted, archiveNames(entries))
		}
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
	admin.SetBackupBaseDir(filepath.Join(dir, "backups"))
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
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

// TestHandleArchive_UploadsOutsideDataDir: upload.storage_dir moved off the
// data dir is still part of a complete restore, archived as data/uploads/.
func TestHandleArchive_UploadsOutsideDataDir(t *testing.T) {
	f := newArchiveFixture(t, func(dir string, cfg *config.Config) {
		ext := filepath.Join(dir, "big", "uploads")
		if err := os.MkdirAll(filepath.Join(ext, "ab"), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(ext, "ab", "far.bin"), []byte("far away"), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg.Upload.StorageDir = ext
	})
	entries := archiveEntries(t, f)
	if got := string(entries["data/uploads/ab/far.bin"]); got != "far away" {
		t.Errorf("external upload entry = %q, want the upload bytes; got %v", got, archiveNames(entries))
	}
}

// TestHandleArchive_BackupDirIsDataDir: backup.dir set to the data dir itself
// must not drop the whole data dir from the archive.
func TestHandleArchive_BackupDirIsDataDir(t *testing.T) {
	f := newArchiveFixture(t, func(_ string, cfg *config.Config) {
		cfg.Backup.Dir = cfg.Server.DataDir
	})
	entries := archiveEntries(t, f)
	for _, want := range []string{"data/chatserver.db", "data/uploads/hello.bin", "data/totp.key"} {
		if _, ok := entries[want]; !ok {
			t.Errorf("archive is missing %q; got %v", want, archiveNames(entries))
		}
	}
	for name := range entries {
		if strings.Contains(name, "owncord-archive") {
			t.Errorf("archive carries its own work dir entry %q", name)
		}
	}
}

// TestHandleArchive_KeepsFileModes: an extracted key file must come back
// 0600, not world-readable.
func TestHandleArchive_KeepsFileModes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no POSIX permission bits; every file reads back 0666. Covered on the Linux runner")
	}
	f := newArchiveFixture(t)
	modes := map[string]os.FileMode{}
	for _, zf := range archiveZip(t, f).File {
		modes[zf.Name] = zf.Mode().Perm()
	}
	for _, name := range []string{"data/totp.key", "data/chatserver.db", "config.yaml"} {
		if got := modes[name]; got != 0o600 {
			t.Errorf("%s mode = %o, want 600", name, got)
		}
	}
}

// TestHandleArchive_StoresUploadsUncompressed: attachments are stored as-is
// (recompressing media only slows the build); the database and config are
// still deflated.
func TestHandleArchive_StoresUploadsUncompressed(t *testing.T) {
	f := newArchiveFixture(t)
	methods := map[string]uint16{}
	for _, zf := range archiveZip(t, f).File {
		methods[zf.Name] = zf.Method
	}
	want := map[string]uint16{
		"data/uploads/hello.bin": zip.Store,
		"data/chatserver.db":     zip.Deflate,
		"config.yaml":            zip.Deflate,
	}
	for name, method := range want {
		if got, ok := methods[name]; !ok || got != method {
			t.Errorf("%s method = %d (present %v), want %d", name, got, ok, method)
		}
	}
}

// TestHandleArchive_RefusesBelowFreeDiskFloor: a build that would take the
// backup volume below server.min_free_disk_mb is refused up front with a 507
// the panel shows, and leaves no work dir behind.
func TestHandleArchive_RefusesBelowFreeDiskFloor(t *testing.T) {
	var backups string
	f := newArchiveFixture(t, func(_ string, cfg *config.Config) {
		cfg.Server.MinFreeDiskMB = 1 << 40
		backups = cfg.Backup.Dir
	})
	w := doRequest(t, f.handler, http.MethodGet, "/archive", f.token, nil)
	if w.Code != http.StatusInsufficientStorage {
		t.Fatalf("GET /archive below the free-disk floor = %d, want 507; body: %s", w.Code, w.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %s", w.Body.String())
	}
	if !strings.Contains(body["message"], "min_free_disk_mb") {
		t.Errorf("message = %q, want it to name server.min_free_disk_mb", body["message"])
	}
	left, err := os.ReadDir(backups)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range left {
		if strings.HasPrefix(e.Name(), "owncord-archive-") {
			t.Errorf("refused build left its work dir %s behind", e.Name())
		}
	}
}

// TestHandleArchive_UploadDuringBuildIsArchived: an upload that lands after
// the space-check plan but before the snapshot is recorded by the snapshot,
// so its file must be in the archive too.
func TestHandleArchive_UploadDuringBuildIsArchived(t *testing.T) {
	f := newArchiveFixture(t)
	late := filepath.Join(f.dataDir, "uploads", "late.bin")
	restore := admin.SetArchiveBeforeSnapshotHook(func() {
		if err := os.WriteFile(late, []byte("late upload"), 0o600); err != nil {
			t.Error(err)
		}
	})
	defer restore()

	entries := archiveEntries(t, f)
	if got := string(entries["data/uploads/late.bin"]); got != "late upload" {
		t.Errorf("upload landed before the snapshot is missing from the archive; got %v", archiveNames(entries))
	}
}

// TestHandleArchive_NoRunningConfigIs500: without the running config there is
// no data dir to archive, so the handler refuses rather than guessing one.
func TestHandleArchive_NoRunningConfigIs500(t *testing.T) {
	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database),
		admin.SetupOptions{})
	token := createAdminUser(t, database)

	if w := doRequest(t, handler, http.MethodGet, "/archive", token, nil); w.Code != http.StatusInternalServerError {
		t.Errorf("GET /archive without a running config = %d, want 500", w.Code)
	}
}

func archiveNames(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
