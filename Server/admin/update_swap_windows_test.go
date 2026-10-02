//go:build windows

package admin_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"

	"golang.org/x/sys/windows"

	"github.com/J3vb/OwnCord/Server/admin"
)

// A server on a Windows console stays behind until its replacement exits,
// holding its image — the binary the first update moved aside — open without
// FILE_SHARE_DELETE. The replacement's own update must still be able to move
// the running binary aside.
func TestApplyStagedUpdate_SecondUpdateWhileAnEarlierBinaryIsStillRunning(t *testing.T) {
	exePath, newPath, stagedHash := stageFakeUpdate(t)
	if !admin.ApplyStagedUpdate(nil, exePath, newPath, stagedHash) {
		t.Fatal("first ApplyStagedUpdate = false, want committed swap")
	}
	olds := oldBinaries(t, exePath)
	if len(olds) != 1 {
		t.Fatalf("old binaries after the first update = %v, want one", olds)
	}
	name, err := windows.UTF16PtrFromString(olds[0])
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(h) })

	staged := []byte("second release")
	if err := os.WriteFile(newPath, staged, 0o755); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(staged)
	if !admin.ApplyStagedUpdate(nil, exePath, newPath, hex.EncodeToString(sum[:])) {
		t.Fatal("second ApplyStagedUpdate = false while the first update's binary is still running")
	}
	if got, err := os.ReadFile(exePath); err != nil || string(got) != "second release" {
		t.Errorf("exePath contents = %q, err=%v; want the second release", got, err)
	}
	if got := oldBinaries(t, exePath); len(got) != 2 {
		t.Errorf("old binaries after the second update = %v, want both previous ones", got)
	}
}
