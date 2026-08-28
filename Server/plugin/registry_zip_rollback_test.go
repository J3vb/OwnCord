//go:build !wazero

// OC-0265: InstallFromZip's promote step (installZipPromote) deletes the
// currently-installed plugin's on-disk files with os.RemoveAll and only
// afterwards renames the staged new version into place — before
// installFromDisk has done the DB upsert that actually records the upgrade.
// If installFromDisk then fails for any reason (context cancellation, a
// write error, SQLITE_BUSY, ...), InstallFromZip returns an error with no
// rollback: the previous version's files are already gone. This test forces
// that failure via a PluginStore whose InstallPlugin call fails on the
// second invocation — the one belonging to the upgrade, not the initial
// LoadAll install — and asserts the previously-installed version's file
// content survives on disk despite the reported failure.
package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// failNthInstallStore wraps a real *db.DB (satisfying PluginStore via
// promoted methods) and fails the Nth call to InstallPlugin with a fixed
// error, delegating every other call and every other method untouched.
type failNthInstallStore struct {
	*db.DB
	calls  int
	failAt int
	err    error
}

func (s *failNthInstallStore) InstallPlugin(ctx context.Context, name, version, manifestJSON string) (int64, error) {
	s.calls++
	if s.calls == s.failAt {
		return 0, s.err
	}
	return s.DB.InstallPlugin(ctx, name, version, manifestJSON)
}

func TestRegistry_InstallFromZip_UpgradeFailureDoesNotDestroyOldVersion(t *testing.T) {
	dir := t.TempDir()
	realStore := openPluginTestDB(t)
	// Call #1 is LoadAll's initial install of v1 (must succeed so there is an
	// existing version to upgrade). Call #2 is the upgrade's installFromDisk,
	// which we force to fail — simulating an aborted request context or a
	// transient store error during a hot upgrade.
	store := &failNthInstallStore{DB: realStore, failAt: 2, err: context.Canceled}

	r, err := NewRegistry(Config{Directory: dir, Store: store})
	if err != nil {
		t.Fatalf("NewRegistry: %v", err)
	}
	t.Cleanup(func() { _ = r.Close(context.Background()) })

	ctx := context.Background()
	writePluginDir(t, dir, "foo", simpleManifest("foo"))
	v1Path := filepath.Join(dir, "foo", "foo.wasm")
	if err := os.WriteFile(v1Path, []byte("v1-marker"), 0o600); err != nil {
		t.Fatalf("write v1 marker: %v", err)
	}
	if err := r.LoadAll(ctx); err != nil {
		t.Fatalf("LoadAll: %v", err)
	}

	zipBytes := buildZip(t, map[string]string{
		"plugin.json": simpleManifest("foo"),
		"foo.wasm":    "v2-marker",
	})
	if _, err := r.InstallFromZip(ctx, zipBytes); err == nil {
		t.Fatal("InstallFromZip succeeded despite the simulated installFromDisk failure; want an error")
	}

	got, readErr := os.ReadFile(v1Path)
	if readErr != nil {
		t.Fatalf("plugin file missing after a failed upgrade (err = %v) — the previously-installed "+
			"version's files must survive an upgrade whose DB write failed", readErr)
	}
	if string(got) != "v1-marker" {
		t.Errorf("plugin file content = %q after a failed upgrade, want the untouched v1 content %q "+
			"— the promote step destroyed the old version before the upgrade was confirmed", got, "v1-marker")
	}
}
