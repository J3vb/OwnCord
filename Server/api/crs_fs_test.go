package api

import (
	"io/fs"
	"testing"

	coreruleset "github.com/corazawaf/coraza-coreruleset/v4"
)

// backslashInclude is the exact name coraza's parser produces on Windows when
// expanding "Include @owasp_crs/*.conf": filepath.Join rewrites the separator,
// so the CRS FS is asked for a backslash path. This is what broke Windows CI.
const backslashInclude = `@owasp_crs\REQUEST-901-INITIALIZATION.conf`

// TestSlashFS_ResolvesBackslashPath reproduces the Windows CRS-load failure on
// any OS: the embedded ruleset FS cannot resolve a backslash path, but the
// slashFS wrapper normalizes it and resolves it. Runs identically on Linux
// because the backslash name is constructed literally, not via filepath.
func TestSlashFS_ResolvesBackslashPath(t *testing.T) {
	// The raw coreruleset FS rejects a backslash path (embed.FS is
	// forward-slash only) — exactly the Windows failure mode.
	if _, err := fs.ReadFile(coreruleset.FS, backslashInclude); err == nil {
		t.Fatalf("expected raw coreruleset FS to fail on %q, got nil error", backslashInclude)
	}

	// The wrapper normalizes the separator and resolves the file.
	data, err := fs.ReadFile(slashFS{coreruleset.FS}, backslashInclude)
	if err != nil {
		t.Fatalf("slashFS.ReadFile(%q): %v", backslashInclude, err)
	}
	if len(data) == 0 {
		t.Fatalf("slashFS.ReadFile(%q) returned empty file", backslashInclude)
	}

	// A forward-slash path still works (no-op normalization).
	if _, err := fs.ReadFile(slashFS{coreruleset.FS}, "@owasp_crs/REQUEST-901-INITIALIZATION.conf"); err != nil {
		t.Fatalf("slashFS.ReadFile forward-slash: %v", err)
	}
}

// TestSlashFS_GlobNormalizes verifies the Glob passthrough returns the CRS rule
// files, which is how coraza expands the "@owasp_crs/*.conf" include.
func TestSlashFS_GlobNormalizes(t *testing.T) {
	matches, err := fs.Glob(slashFS{coreruleset.FS}, "@owasp_crs/*.conf")
	if err != nil {
		t.Fatalf("slashFS.Glob: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("slashFS.Glob(@owasp_crs/*.conf) returned no matches")
	}
}
