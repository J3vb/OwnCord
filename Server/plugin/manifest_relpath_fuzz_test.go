package plugin

import (
	"strings"
	"testing"
)

// FuzzValidateRelativePath asserts that whenever validateRelativePath
// accepts a path (returns nil), that path is genuinely contained under the
// plugin base directory: not absolute, not empty, containing no ".."
// traversal component (checked as a real path segment, not just a
// substring, so a segment like "..foo" or "foo.." can't false-positive),
// no NUL byte, no backslash, and no leading separator.
func FuzzValidateRelativePath(f *testing.F) {
	seeds := []string{
		"",
		".",
		"..",
		"/",
		"/etc/passwd",
		"a/b/c.js",
		"../secret",
		"a/../../secret",
		"a/../b",
		"./a",
		"a//b",
		"a/",
		"a/b/",
		"\\windows\\evil",
		"a\\b",
		"a\x00b",
		"..a",
		"a..",
		"a..b",
		"foo/..bar",
		"C:\\evil.dll",
		strings.Repeat("a/", 100) + "x.js",
		"a/./b",
		"a/../b/../c",
	}
	for _, s := range seeds {
		f.Add(s)
	}

	f.Fuzz(func(t *testing.T, p string) {
		err := validateRelativePath(p)
		if err != nil {
			return
		}

		// Accepted: verify genuine containment under the plugin base dir.
		if p == "" {
			t.Fatalf("validateRelativePath(%q) = nil but path is empty", p)
		}
		if strings.ContainsRune(p, 0) {
			t.Fatalf("validateRelativePath(%q) = nil but path contains a NUL byte", p)
		}
		if strings.ContainsRune(p, '\\') {
			t.Fatalf("validateRelativePath(%q) = nil but path contains a backslash", p)
		}
		if strings.HasPrefix(p, "/") {
			t.Fatalf("validateRelativePath(%q) = nil but path is absolute", p)
		}
		if p == "." {
			t.Fatalf("validateRelativePath(%q) = nil but path is the current directory", p)
		}
		for seg := range strings.SplitSeq(p, "/") {
			if seg == ".." {
				t.Fatalf("validateRelativePath(%q) = nil but path contains a %q traversal segment", p, "..")
			}
		}
	})
}
