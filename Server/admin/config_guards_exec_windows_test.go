//go:build windows

package admin

import (
	"os"
	"path/filepath"
	"testing"
)

// Windows has no POSIX execute permission bit: Go reports a regular .exe with
// read/write bits only. The LiveKit-binary guard must not reject every Windows
// binary on the exec-bit test.
func TestBinaryExecutable_WindowsRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "livekit-server.exe")
	if err := os.WriteFile(path, []byte("MZ"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 != 0 {
		t.Fatalf("fixture unexpectedly has an execute bit: %v", info.Mode())
	}
	if !binaryExecutable(info) {
		t.Error("binaryExecutable(regular Windows file) = false, want true")
	}
}
