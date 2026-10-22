package updater

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Run from a copied test executable so the helper can perform the same rename
// as a real update without moving the test runner that owns the suite.
func TestExecutablePath_RemainsStableAfterRename(t *testing.T) {
	const helperEnv = "OWNCORD_TEST_EXECUTABLE_RENAME"
	if os.Getenv(helperEnv) == "1" {
		assertExecutablePathAfterRename(t)
		return
	}

	sourcePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()

	exePath := filepath.Join(t.TempDir(), "chatserver.exe")
	dest, err := os.OpenFile(exePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(dest, source)
	closeErr := dest.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}

	cmd := exec.CommandContext(t.Context(), exePath, "-test.run=^TestExecutablePath_RemainsStableAfterRename$")
	cmd.Env = append(os.Environ(), helperEnv+"=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("update rename helper: %v\n%s", err, output)
	}
}

func assertExecutablePathAfterRename(t *testing.T) {
	t.Helper()
	exePath, err := ExecutablePath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(exePath, exePath+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exePath, []byte("replacement version"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ExecutablePath()
	if err != nil || got != exePath {
		t.Fatalf("path after update = %q, %v; want installation path %q", got, err, exePath)
	}
	if contents, err := os.ReadFile(got); err != nil || string(contents) != "replacement version" {
		t.Fatalf("handoff path points to %q, %v; want replacement version", contents, err)
	}
	if runtime.GOOS == "linux" {
		// Prove that this is the regression condition: a fresh OS lookup
		// would silently launch the backup despite a successful update.
		imagePath, err := os.Executable()
		if err != nil || imagePath != exePath+".old" {
			t.Fatalf("renamed running image = %q, %v; want %q", imagePath, err, exePath+".old")
		}
	}
}

func TestCanReplaceExecutable_WritableDir(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "chatserver")
	if err := CanReplaceExecutable(exePath); err != nil {
		t.Fatalf("CanReplaceExecutable = %v, want nil", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("probe left %d file(s) behind: %v", len(entries), entries)
	}
}

func TestCanReplaceExecutable_ReadOnlyDir(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permission bits do not make a Windows folder read-only")
	}
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := t.TempDir()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })

	err := CanReplaceExecutable(filepath.Join(dir, "chatserver"))
	if err == nil {
		t.Fatal("CanReplaceExecutable = nil, want an error for a read-only directory")
	}
	if !strings.Contains(err.Error(), dir) {
		t.Errorf("error %q does not name the directory", err)
	}
}
