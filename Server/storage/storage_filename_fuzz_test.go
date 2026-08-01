package storage

import (
	"path/filepath"
	"strings"
	"testing"
)

// FuzzSanitizeFilename checks sanitizeFilename's own documented contract
// (no separators, not "."/".."/"" and not a leading dot) and, more
// importantly, its safety composition with (*Storage).resolvedPath: any name
// that sanitizeFilename accepts must resolve to a path that both succeeds
// and stays inside the storage directory. A name that passes sanitize but
// escapes the directory in resolvedPath would be a real path-traversal bug.
func FuzzSanitizeFilename(f *testing.F) {
	seeds := []string{
		"",
		".",
		"..",
		"...",
		"/",
		"\\",
		"a/b",
		"a\\b",
		".hidden",
		"..secret",
		"normal-file.txt",
		"/etc/passwd",
		"../../../etc/passwd",
		"..\\..\\windows\\system32\\config",
		"a/../../b",
		"~root",
		"foo/",
		"/foo",
		"foo\x00bar",
		"con",
		"NUL",
		strings.Repeat("a", 300),
		"..a",
		"a..",
		"a.b",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	dir := f.TempDir()
	s, err := New(dir, 10)
	if err != nil {
		f.Fatalf("New(%q, 10) failed: %v", dir, err)
	}
	absDir, err := filepath.Abs(dir)
	if err != nil {
		f.Fatalf("filepath.Abs(%q) failed: %v", dir, err)
	}

	f.Fuzz(func(t *testing.T, name string) {
		err := sanitizeFilename(name)
		if err != nil {
			// sanitizeFilename rejected it -- nothing further to assert about
			// its own contract, but we still cross-check resolvedPath below
			// isn't the sole gatekeeper (defense in depth), so just return.
			return
		}

		// sanitizeFilename returned nil: verify its documented contract.
		if name == "" {
			t.Fatalf("sanitizeFilename(%q) = nil but name is empty", name)
		}
		if name == "." || name == ".." {
			t.Fatalf("sanitizeFilename(%q) = nil but name is a reserved dot-name", name)
		}
		if strings.HasPrefix(name, ".") {
			t.Fatalf("sanitizeFilename(%q) = nil but name starts with '.'", name)
		}
		if strings.ContainsAny(name, "/\\") {
			t.Fatalf("sanitizeFilename(%q) = nil but name contains a path separator", name)
		}
		if filepath.Base(name) != name {
			t.Fatalf("sanitizeFilename(%q) = nil but filepath.Base(name) = %q differs", name, filepath.Base(name))
		}

		// Safety composition: resolvedPath must succeed and stay inside dir.
		target, err := s.resolvedPath(name)
		if err != nil {
			t.Fatalf("sanitizeFilename(%q) = nil but resolvedPath failed: %v", name, err)
		}
		if target != absDir && !strings.HasPrefix(target, absDir+string(filepath.Separator)) {
			t.Fatalf("sanitizeFilename(%q) = nil but resolvedPath(%q) = %q escapes storage dir %q", name, name, target, absDir)
		}
	})
}
