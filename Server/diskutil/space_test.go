//go:build linux || darwin || windows

package diskutil

import "testing"

func TestSpace(t *testing.T) {
	free, total, err := Space(t.TempDir())
	if err != nil {
		t.Fatalf("Space: %v", err)
	}
	if total == 0 || free > total {
		t.Errorf("Space = free %d of %d, want 0 < free <= total", free, total)
	}
	if _, _, err := Space("/no/such/path/owncord"); err == nil {
		t.Error("Space(missing path): no error")
	}
}
