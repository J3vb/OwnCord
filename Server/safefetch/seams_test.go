package safefetch

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// seamFields replace the boundary rather than configure it: a call site that
// sets one has opted out of the address policy, the resolver, the connect, or
// certificate verification. They exist for tests that must reach an httptest
// stub, and for B7 to layer its own rule on top.
var seamFields = []string{"Classify", "Resolve", "Dial", "TLSConfig"}

// A production Policy must be a composite literal that names ContentTypes and
// none of the seams. The rule is three parts, and it needs all three: a bare
// `var p safefetch.Policy` followed by `p.Classify = ...` sets a seam without
// ever writing a literal, and a literal with no ContentTypes key disables the
// media-type check by omission.
//
// This started as a text scan for lines beginning with `Classify:`, which an
// adversarial pass walked straight past with the assignment form. Parsing is
// the fix: the shape of the expression no longer matters.
func TestProductionPolicyShape(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	for _, file := range policyFiles(t, root) {
		checkPolicyFile(t, file.rel, file.f)
	}
}

type parsedFile struct {
	rel string
	f   *ast.File
}

// policyFiles parses every non-test .go file under the server tree that could
// name this package's Policy: one that imports safefetch, or one of this
// package's own files.
func policyFiles(t *testing.T, root string) []parsedFile {
	t.Helper()
	var out []parsedFile
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if strings.HasPrefix(rel, "safefetch/") || importsSafefetch(f) {
			out = append(out, parsedFile{rel: rel, f: f})
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("no production file names safefetch.Policy — this gate would pass vacuously")
	}
	return out
}

func importsSafefetch(f *ast.File) bool {
	for _, imp := range f.Imports {
		if imp.Path != nil && strings.Contains(imp.Path.Value, "/Server/safefetch") {
			return true
		}
	}
	return false
}

// checkPolicyFile enforces the three parts of the rule on one parsed file.
func checkPolicyFile(t *testing.T, rel string, f *ast.File) {
	t.Helper()
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CompositeLit:
			if !isPolicyType(x.Type) {
				return true
			}
			var keys []string
			for _, elt := range x.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				if id, ok := kv.Key.(*ast.Ident); ok {
					keys = append(keys, id.Name)
				}
			}
			for _, seam := range seamFields {
				if slices.Contains(keys, seam) {
					t.Errorf("%s: a production safefetch.Policy sets the %s seam — that replaces the destination boundary, and only a _test.go file may do it", rel, seam)
				}
			}
			if !slices.Contains(keys, "ContentTypes") {
				t.Errorf("%s: a production safefetch.Policy omits ContentTypes — an empty allowlist accepts any media type", rel)
			}
		case *ast.AssignStmt:
			// `p.Classify = f` reaches the same place as the literal key and
			// is what the old text scan missed.
			for _, lhs := range x.Lhs {
				sel, ok := lhs.(*ast.SelectorExpr)
				if !ok {
					continue
				}
				if slices.Contains(seamFields, sel.Sel.Name) {
					t.Errorf("%s: a production file assigns .%s — if that is a safefetch.Policy it replaces the destination boundary; only a _test.go file may do it", rel, sel.Sel.Name)
				}
			}
		case *ast.ValueSpec:
			// `var p safefetch.Policy` escapes the literal rule entirely, so
			// the declaration form is refused outright.
			if isPolicyType(x.Type) && len(x.Values) == 0 {
				t.Errorf("%s: a production file declares a zero safefetch.Policy — build it as a composite literal so its ceilings and seams are visible in one place", rel)
			}
		}
		return true
	})
}

// isPolicyType matches `safefetch.Policy` from outside and `Policy` from
// inside this package, plus the pointer forms.
func isPolicyType(e ast.Expr) bool {
	switch x := e.(type) {
	case *ast.StarExpr:
		return isPolicyType(x.X)
	case *ast.SelectorExpr:
		id, ok := x.X.(*ast.Ident)
		return ok && id.Name == "safefetch" && x.Sel.Name == "Policy"
	case *ast.Ident:
		return x.Name == "Policy"
	}
	return false
}

// A Policy's slice fields alias the caller's arrays. New copies them, so a
// caller that reuses or mutates its Policy value afterwards cannot widen what
// an existing Fetcher accepts.
func TestNew_CopiesPolicySlices(t *testing.T) {
	schemes := []string{"https"}
	types := []string{"application/json"}
	ports := []int{443}
	f, err := New(Policy{
		Schemes:              schemes,
		Ports:                ports,
		ContentTypes:         types,
		MaxRedirects:         1,
		Deadline:             time.Second,
		MaxBytes:             1 << 10,
		MaxDecompressedBytes: 1 << 10,
		MaxConcurrent:        1,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	schemes[0] = "http"
	types[0] = "text/html"
	ports[0] = 8080

	if slices.Contains(f.policy.Schemes, "http") {
		t.Error("mutating the caller's Schemes slice changed the Fetcher's")
	}
	if f.typeAllowed("text/html") {
		t.Error("mutating the caller's ContentTypes slice changed the Fetcher's")
	}
	if slices.Contains(f.ports, 8080) {
		t.Error("mutating the caller's Ports slice changed the Fetcher's")
	}
}
