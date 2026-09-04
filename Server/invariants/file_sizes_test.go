package invariants

import (
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFileSizes_Rule locks OC-0400: hub.go crept back over its 400-line B3-5
// exit target with nothing to catch it. A file at exactly its limit passes;
// one line over fails; a file outside FileSizeLimits is never checked, no
// matter how long.
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
		{"at the limit", "ws/hub.go", build(400), 0},
		{"one line over", "ws/hub.go", build(401), 1},
		{"unlisted file, arbitrarily long", "ws/unrelated.go", build(5000), 0},
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

// TestFileSizeLimitsAreLive proves every file the invariant watches is under
// its own limit on HEAD — the rule is worthless if the tree it runs over is
// already in violation and nobody noticed.
func TestFileSizeLimitsAreLive(t *testing.T) {
	root := serverRoot(t)
	for rel, limit := range FileSizeLimits {
		fset := token.NewFileSet()
		src, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Fatalf("reading %s: %v", rel, err)
		}
		var got int
		for _, v := range checkSourceWith([]Rule{fileSizes}, fset, rel, src) {
			got++
			t.Errorf("%s: %s", rel, v.Msg)
		}
		if got == 0 {
			t.Logf("%s: within its %d-line limit", rel, limit)
		}
	}
}
