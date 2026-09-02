package invariants

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"testing"
)

// serverRoot is the Server module directory: tests run with the package
// directory as their working directory.
func serverRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	return root
}

// Every inventory row still names a file that opens an outbound path;
// a row nothing needs any more is a lie about where the server can reach.
func TestEgressAllowIsLive(t *testing.T) {
	root := serverRoot(t)
	for rel := range EgressAllow {
		src, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			t.Errorf("EgressAllow lists %s, which does not exist: %v", rel, err)
			continue
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, rel, src, parser.ImportsOnly|parser.ParseComments)
		if err != nil {
			t.Errorf("parse %s: %v", rel, err)
			continue
		}
		// ImportsOnly is enough for the OTLP row; every other row needs bodies.
		if len(egressHits(f, fset)) == 0 {
			f, err = parser.ParseFile(fset, rel, src, parser.ParseComments)
			if err != nil {
				t.Errorf("parse %s: %v", rel, err)
				continue
			}
			if len(egressHits(f, fset)) == 0 {
				t.Errorf("EgressAllow lists %s, but it no longer opens an outbound path — drop the row", rel)
			}
		}
	}
}

// An unlisted file that reaches out is a violation; the same code in a
// listed file is not; a file that only serves HTTP is never one.
func TestEgressSites_Rule(t *testing.T) {
	reach := `package x
import "net/http"
func f() { _, _ = http.Get("https://example.invalid/") }
`
	serve := `package x
import "net/http"
func h(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }
`
	otlp := `package x
import _ "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
`
	aliased := `package x
import nh "net/http"
func f() { c := &nh.Client{}; _ = c }
`
	dialer := `package x
import "net"
func f() { d := net.Dialer{}; _, _ = d.Dial("tcp", "example.invalid:443") }
`
	cases := []struct {
		name, rel, src string
		want           int
	}{
		{"unlisted http.Get", "service/reach.go", reach, 1},
		{"listed file", "updater/updater.go", reach, 0},
		{"handler only", "api/serve.go", serve, 0},
		{"otlp import", "telemetry/x.go", otlp, 1},
		{"aliased client literal", "service/x.go", aliased, 1},
		{"net.Dialer literal", "service/y.go", dialer, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fset := token.NewFileSet()
			got := 0
			for _, v := range CheckSource(fset, tc.rel, []byte(tc.src)) {
				if v.Rule == egressSitesID {
					got++
				}
			}
			if got != tc.want {
				t.Fatalf("egress-sites violations = %d, want %d", got, tc.want)
			}
		})
	}
}
