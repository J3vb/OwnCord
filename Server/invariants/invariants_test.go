package invariants

import (
	"os"
	"path/filepath"
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
