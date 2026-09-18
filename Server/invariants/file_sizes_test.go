package invariants

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFileSizes_Rule locks OC-0400 and the default-ceiling inversion: an
// unlisted file is capped at DefaultFileLimit, a declared exemption is capped
// at its own ceiling, a file at exactly its limit passes, one line over fails,
// and cmd/ is out of scope entirely.
func TestFileSizes_Rule(t *testing.T) {
	// build returns a syntactically valid file of exactly n lines: a package
	// clause, then n-1 blank comment lines.
	build := func(n int) string {
		var b strings.Builder
		b.WriteString("package x\n")
		for i := 1; i < n; i++ {
			b.WriteString("//\n")
		}
		return b.String()
	}

	cases := []struct {
		name string
		rel  string
		src  string
		want int
	}{
		{"exempt file at its ceiling", "ws/hub.go", build(400), 0},
		{"exempt file one line over", "ws/hub.go", build(401), 1},
		{"unlisted file at the default", "ws/unrelated.go", build(500), 0},
		{"unlisted file one line over the default", "ws/unrelated.go", build(501), 1},
		{"unlisted file, arbitrarily long", "ws/unrelated.go", build(5000), 1},
		{"exempt file under the default is not capped by it", "db/markers.go", build(600), 0},
		// cmd/ holds entry points and one-shot tooling; a long main there is a
		// shape, not a smell. The largest Go file in the tree lives in it.
		{"cmd/ is out of scope", "cmd/smoke/drills.go", build(5000), 0},
		{"cmd/ at the root is out of scope", "cmd/seed/main.go", build(5000), 0},
		// Not a cmd/ prefix: a sibling directory whose name merely starts with it.
		{"a directory named cmdfoo/ is not cmd/", "cmdfoo/x.go", build(501), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			got := 0
			for _, v := range CheckSource(fset, tc.rel, []byte(tc.src)) {
				if v.Rule == fileSizesID {
					got++
				}
			}
			if got != tc.want {
				t.Fatalf("file-sizes violations = %d, want %d", got, tc.want)
			}
		})
	}
}

// lineCountOf returns rel's line count under root, on the same basis the rule
// measures with: a parse, then go/token's LineCount, which for a
// newline-terminated file equals wc -l.
func lineCountOf(t *testing.T, root, rel string) int {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, rel, src, parser.ParseComments)
	if err != nil {
		t.Fatalf("parsing %s: %v", rel, err)
	}
	return fset.File(f.Pos()).LineCount()
}

// TestFileSizeOverridesAreSane keeps the exemption table itself honest: every
// row names a real file, carries a class the rule defines and a note that lets
// a reader judge it, sits on the right side of the default for its class, and
// is not already exceeded. A row that has outlived its reason is deleted
// rather than left behind as a licence.
func TestFileSizeOverridesAreSane(t *testing.T) {
	root := serverRoot(t)
	for rel, o := range FileSizeOverrides {
		lines := lineCountOf(t, root, rel)
		switch o.Class {
		case classB3ExitTarget:
			if o.Ceiling > DefaultFileLimit {
				t.Errorf("%s: b3-exit-target ceiling %d is looser than the %d default",
					rel, o.Ceiling, DefaultFileLimit)
			}
		case classGrandfathered:
			if o.Ceiling <= DefaultFileLimit {
				t.Errorf("%s: grandfathered ceiling %d is at or under the %d default — "+
					"delete the row instead", rel, o.Ceiling, DefaultFileLimit)
			}
		default:
			t.Errorf("%s: class %q is not one the rule defines", rel, o.Class)
		}
		if o.Note == "" {
			t.Errorf("%s: no note, so the row cannot be judged", rel)
		}
		if lines > o.Ceiling {
			t.Errorf("%s: %d lines is already over its declared ceiling %d", rel, lines, o.Ceiling)
		}
	}
}

// TestFileSizeLimitsAreLive proves the whole tree is green under the rule, not
// just the files it names — the anti-drift property the default ceiling exists
// for. A file that grows past its effective ceiling fails here whether or not
// anyone remembered to list it.
func TestFileSizeLimitsAreLive(t *testing.T) {
	// First prove the sweep can fail at all: the walker feeds every non-test
	// .go file, so one over-limit file in a tree must surface. Without this
	// the run below would read green whether or not it visited anything.
	dir := t.TempDir()
	over := strings.Repeat("//\n", DefaultFileLimit) // +1 for the package clause
	if err := os.MkdirAll(filepath.Join(dir, "ws"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ws", "over.go"),
		[]byte("package ws\n"+over), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := runWith([]Rule{fileSizes}, dir)
	if err != nil {
		t.Fatalf("running file-sizes over a temp tree: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("temp tree: %d violations, want 1 — the sweep is not reaching files", len(got))
	}

	root := serverRoot(t)
	violations, err := runWith([]Rule{fileSizes}, root)
	if err != nil {
		t.Fatalf("running file-sizes over %s: %v", root, err)
	}
	for _, v := range violations {
		t.Errorf("%s", v.Msg)
	}
}
