package db

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var sqlcNameLine = regexp.MustCompile(`^-- name: (\w+) :(\w+)`)

// generatedQueries returns every sqlc query constant in dbgen by its query
// name, as the exact text the router sees at run time.
func generatedQueries(t *testing.T) map[string]struct{ kind, text string } {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("dbgen", "*.sql.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("glob dbgen: %v (%d files)", err, len(files))
	}
	out := map[string]struct{ kind, text string }{}
	fset := token.NewFileSet()
	for _, f := range files {
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", f, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			text, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			m := sqlcNameLine.FindStringSubmatch(text)
			if m == nil {
				return true
			}
			out[m[1]] = struct{ kind, text string }{m[2], text}
			return true
		})
	}
	return out
}

// TestIsReadOnlySQL_GeneratedQueries runs the router's classification over
// the real generated query text. A :one or :many query reads unless it has
// RETURNING, so it must go to the reader; one with RETURNING must stay on
// the writer.
func TestIsReadOnlySQL_GeneratedQueries(t *testing.T) {
	queries := generatedQueries(t)
	if len(queries) < 300 {
		t.Fatalf("found %d generated queries, want the full dbgen set", len(queries))
	}
	checked := 0
	for name, q := range queries {
		if q.kind != "one" && q.kind != "many" {
			continue
		}
		checked++
		want := !strings.Contains(strings.ToUpper(q.text), "RETURNING")
		if got := isReadOnlySQL(q.text); got != want {
			t.Errorf("%s (:%s): isReadOnlySQL = %v, want %v", name, q.kind, got, want)
		}
	}
	if checked == 0 {
		t.Fatal("no :one or :many queries checked")
	}
	q, ok := queries["ListThreadInfosByParent"]
	if !ok {
		t.Fatal("ListThreadInfosByParent not found in dbgen")
	}
	if !isReadOnlySQL(q.text) {
		t.Error("ListThreadInfosByParent routes to the writer")
	}
}
