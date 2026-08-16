package invariants

import (
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestServerInvariants is the gate. It runs every registered rule over the
// real server tree and reports every violation at once.
func TestServerInvariants(t *testing.T) {
	violations, err := Run("..")
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
	if len(violations) > 0 {
		t.Logf("%d invariant violation(s). Each message names the fix; "+
			"use //invariant:allow <rule> — <reason> only with a real reason.",
			len(violations))
	}

	assertScopesCovered(t, "..")
}

// assertScopesCovered guards against the gate passing vacuously: zero
// violations is indistinguishable from zero files scanned (a moved package,
// or a Scope entry that no longer exists, would go green while enforcing
// nothing). It fails loudly, naming the offending Scope entry, if any
// registered Rule.Scope directory does not exist under root or holds no
// non-test .go file.
func assertScopesCovered(t *testing.T, root string) {
	t.Helper()
	for _, r := range Rules {
		for _, scope := range r.Scope {
			dir := filepath.Join(root, filepath.FromSlash(scope))
			info, err := os.Stat(dir)
			if err != nil || !info.IsDir() {
				t.Fatalf("rule %q Scope entry %q does not resolve to a directory under %q: %v",
					r.ID, scope, root, err)
				continue
			}

			found := false
			walkErr := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !d.IsDir() && strings.HasSuffix(p, ".go") && !strings.HasSuffix(p, "_test.go") {
					found = true
				}
				return nil
			})
			if walkErr != nil {
				t.Fatalf("walking rule %q Scope entry %q: %v", r.ID, scope, walkErr)
			}
			if !found {
				t.Fatalf("rule %q Scope entry %q contains no non-test .go file under %q; "+
					"the gate would be enforcing nothing there", r.ID, scope, root)
			}
		}
	}
}

// TestBuildTagGatedFilesAreStillChecked locks in the package doc's central
// anti-evasion guarantee: parser.ParseFile ignores build constraints, so a
// file gated behind e.g. -tags deadlock is checked exactly like any other --
// a raw mutex cannot be hidden from the rules by moving it behind a tag.
func TestBuildTagGatedFilesAreStillChecked(t *testing.T) {
	src := `//go:build deadlock

package ws

import "sync"

type Hub struct{ mu sync.Mutex }
`
	got := CheckSource(token.NewFileSet(), "ws/x.go", []byte(src))
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1: %v", len(got), got)
	}
}

// TestRunExclusions builds a throwaway tree so the walker's exclusions are
// tested directly, rather than vacuously against a clean real tree.
func TestRunExclusions(t *testing.T) {
	root := t.TempDir()
	lock := []byte("package ws\nimport \"sync\"\ntype h struct{ mu sync.Mutex }\n")

	write := func(rel string) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, lock, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("ws/real.go")       // reported
	write("ws/real_test.go")  // excluded: _test.go
	write("ws/testdata/x.go") // excluded: skipDirs
	write("api/other.go")     // excluded: out of scope

	got, err := Run(root)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1:\n%v", len(got), got)
	}
	if got[0].File != "ws/real.go" {
		t.Errorf("File = %q, want %q", got[0].File, "ws/real.go")
	}
}

func TestRuleScopeMatching(t *testing.T) {
	r := Rule{ID: "x", Scope: []string{"ws", "service"}}
	cases := map[string]bool{
		"ws":          true,
		"ws/internal": true,
		"service":     true,
		"api":         false,
		"":            false,
		"wsx":         false,
	}
	for dir, want := range cases {
		if got := r.inScope(dir); got != want {
			t.Errorf("inScope(%q) = %v, want %v", dir, got, want)
		}
	}
}
