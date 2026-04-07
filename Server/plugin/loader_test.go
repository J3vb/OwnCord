// Pass 4 — loader symlink rejection tests.
//
// Locks in the Pass 3 defense against malicious plugin .zip packages that
// ship symlinks to host filesystem paths. http.ServeFile follows symlinks
// transparently, so the only safe time to reject them is at install /
// directory-scan time.
package plugin

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRejectSymlinksUnderClean(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "regular.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "subdir", "nested.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rejectSymlinksUnder(dir); err != nil {
		t.Fatalf("clean directory should pass, got: %v", err)
	}
}

func TestRejectSymlinksUnderFindsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on Windows")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "regular.txt"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Create an evil symlink pointing at /etc/passwd.
	link := filepath.Join(dir, "evil.html")
	if err := os.Symlink("/etc/passwd", link); err != nil {
		t.Skipf("symlink creation failed (likely unsupported FS): %v", err)
	}
	if err := rejectSymlinksUnder(dir); err == nil {
		t.Fatal("expected rejectSymlinksUnder to refuse the symlink")
	}
}

func TestRejectSymlinksUnderFindsNestedSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on Windows")
	}
	dir := t.TempDir()
	sub := filepath.Join(dir, "assets")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(sub, "leak")
	if err := os.Symlink("/etc/passwd", link); err != nil {
		t.Skipf("symlink creation failed: %v", err)
	}
	if err := rejectSymlinksUnder(dir); err == nil {
		t.Fatal("expected nested symlink to be rejected")
	}
}

func TestScanPluginDirectoryRejectsSymlinkEntrypoint(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevated privileges on Windows")
	}
	root := t.TempDir()
	pluginDir := filepath.Join(root, "evil")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Manifest claims hello.wasm; we'll make hello.wasm a symlink.
	manifest := []byte(`{
		"name": "evil",
		"version": "0.1.0",
		"entrypoint": "hello.wasm"
	}`)
	if err := os.WriteFile(filepath.Join(pluginDir, "plugin.json"), manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	// Create a real target then symlink to it (so the target exists; the
	// symlink itself is what we want to reject).
	target := filepath.Join(root, "target.bin")
	if err := os.WriteFile(target, []byte("\x00asm"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(pluginDir, "hello.wasm")); err != nil {
		t.Skipf("symlink creation failed: %v", err)
	}
	_, err := scanPluginDirectory(root)
	if err == nil {
		t.Fatal("scanPluginDirectory should reject plugin with symlinked entrypoint")
	}
}
