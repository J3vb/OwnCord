package db

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWalFilePath(t *testing.T) {
	abs := "/srv/owncord/chat.db"
	if runtime.GOOS == "windows" {
		abs = "C:/srv/owncord/chat.db"
	}
	want := filepath.FromSlash(abs) + "-wal"
	slash := abs
	if runtime.GOOS == "windows" {
		slash = "/" + abs
	}
	for _, tc := range []struct{ in, want string }{
		{abs, want},
		{"data/chat.db", filepath.FromSlash("data/chat.db") + "-wal"},
		{"file:" + slash + "?cache=private", want},
		{"file://" + slash, want},
		{"file://localhost" + slash, want},
		{"file://otherhost" + slash, ""},
		{":memory:", ""},
		{"file:mem?mode=memory&cache=shared", ""},
		{"", ""},
	} {
		if got := walFilePath(tc.in); got != tc.want {
			t.Errorf("walFilePath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWalFilePath_FollowsSymlinkToTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real.db")
	if err := os.WriteFile(target, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	want, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	if got := walFilePath(link); got != want+"-wal" {
		t.Errorf("walFilePath(%q) = %q, want %q", link, got, want+"-wal")
	}
}
