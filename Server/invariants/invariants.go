// Package invariants holds OwnCord-specific structural rules for the server
// tree. Each rule encodes an invariant that is either documented in
// Server/CLAUDE.md or was proven by a real defect in the findings ledger, and
// that the generic linters in .golangci.yml cannot express.
//
// Rules are syntactic. They use go/parser and go/ast only -- no type
// information, no third-party dependency. parser.ParseFile ignores build
// constraints, so files behind -tags otel, -tags wazero and -tags deadlock are
// checked like any other; a rule must not be evadable by moving code behind a
// build tag.
package invariants

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Violation is one rule breach at one source location.
type Violation struct {
	Rule string // stable rule id, e.g. "syncutil-locks"
	File string // slash-separated, relative to the tree root
	Line int
	Msg  string // what is wrong, why it matters, and what to do instead
}

func (v Violation) String() string {
	return fmt.Sprintf("%s:%d: [%s] %s", v.File, v.Line, v.Rule, v.Msg)
}

// Rule is one structural check.
type Rule struct {
	// ID is the stable identifier used in messages and allow comments.
	ID string
	// Scope lists directories relative to the tree root, e.g. {"ws", "service"}.
	// An empty Scope means every directory.
	Scope []string
	// Check inspects one parsed file. rel is the slash-separated path relative
	// to the tree root, and is what the returned Violation.File must carry.
	Check func(f *ast.File, fset *token.FileSet, rel string) []Violation
}

// inScope reports whether dir falls under the rule's Scope. dir is
// slash-separated and relative to the tree root; "" is the root itself.
func (r Rule) inScope(dir string) bool {
	if len(r.Scope) == 0 {
		return true
	}
	for _, s := range r.Scope {
		if dir == s || strings.HasPrefix(dir, s+"/") {
			return true
		}
	}
	return false
}

// Rules is the registry every gate runs.
var Rules = []Rule{syncutilLocks, dbImportBoundary, authzChokepoint}

// importNames returns the local identifiers this file binds to the import
// path, and separately every dot-import of it (import . "p"), which binds no
// identifier at all. A rule that matches pkg.Sym selectors needs both: the
// names to match against, and the dot-imports to report, since a dot-import
// lets the symbol be spelled bare and evade the selector match entirely.
//
// An unaliased import binds the package's own clause name, which is not in the
// file being parsed; the last path element stands in for it. That holds for
// every path these rules care about (all first-party, all named after their
// directory) and would need the package's own source for one where it does not
// (gopkg.in/yaml.v3 binds yaml, not yaml.v3).
func importNames(f *ast.File, importPath string) (names map[string]bool, dotImports []*ast.ImportSpec) {
	names = make(map[string]bool)
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil || p != importPath {
			continue
		}
		switch {
		case imp.Name == nil:
			names[path.Base(importPath)] = true
		case imp.Name.Name == "_":
			// Blank import: no identifier is bound, so pkg.Sym cannot be
			// spelled at all.
		case imp.Name.Name == ".":
			dotImports = append(dotImports, imp)
		default:
			names[imp.Name.Name] = true
		}
	}
	return names, dotImports
}

// enclosingSymbol names the function or method containing pos, in the form
// rules use for a symbol-keyed allowlist: "requirePerm" for a function,
// "(*Hub).canSee" for a method. An expression outside every function body (a
// package-level var initializer) has no enclosing function and gets
// fileScopeSymbol, which no allowlist row is expected to name.
func enclosingSymbol(f *ast.File, pos token.Pos) string {
	for _, d := range f.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok || pos < fd.Pos() || pos >= fd.End() {
			continue
		}
		if fd.Recv == nil || len(fd.Recv.List) == 0 {
			return fd.Name.Name
		}
		return "(" + receiverTypeName(fd.Recv.List[0].Type) + ")." + fd.Name.Name
	}
	return fileScopeSymbol
}

// fileScopeSymbol stands in for "not inside any function".
const fileScopeSymbol = "<file-scope>"

// receiverTypeName renders a method receiver's type syntactically: Hub,
// *Hub, or the generic forms *Hub[T] / *Hub[K, V] reduced to their base name,
// which is what identifies the method. Written by hand rather than with
// go/types.ExprString so the package keeps its go/ast-only promise.
func receiverTypeName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return "*" + receiverTypeName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr: // generic receiver: Hub[T]
		return receiverTypeName(t.X)
	case *ast.IndexListExpr: // generic receiver: Hub[K, V]
		return receiverTypeName(t.X)
	default:
		return "?"
	}
}

// allowPrefix introduces a line-scoped suppression:
//
//	mu sync.Mutex //invariant:allow syncutil-locks — <reason>
//
// The reason is mandatory. An allow comment without one does not suppress
// anything and is itself reported, so the hatch cannot silently disable a
// rule. The comment must be on the same line as the flagged code -- one on
// the line above it is not matched and silently fails to suppress.
const allowPrefix = "//invariant:allow"

// allowIndex maps line number to the set of rule ids suppressed on that line.
// It also returns a violation for every allow comment that names no rule or
// gives no reason.
func allowIndex(f *ast.File, fset *token.FileSet, rel string) (map[int]map[string]bool, []Violation) {
	idx := make(map[int]map[string]bool)
	var bad []Violation

	for _, group := range f.Comments {
		for _, c := range group.List {
			text := strings.TrimSpace(c.Text)
			if !strings.HasPrefix(text, allowPrefix) {
				continue
			}
			line := fset.Position(c.Slash).Line
			rest := strings.TrimSpace(strings.TrimPrefix(text, allowPrefix))
			id, reason, _ := strings.Cut(rest, " ")
			id = strings.TrimSpace(id)
			// Strip the separator between the rule id and the prose reason.
			reason = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(reason), "-—:"))

			if id == "" || reason == "" {
				bad = append(bad, Violation{
					Rule: "invariant-allow-needs-reason",
					File: rel,
					Line: line,
					Msg: "//invariant:allow must name a rule and give a reason, " +
						"e.g. //invariant:allow syncutil-locks — <why this site is exempt>",
				})
				continue
			}
			if idx[line] == nil {
				idx[line] = make(map[string]bool)
			}
			idx[line][id] = true
		}
	}
	return idx, bad
}

// CheckSource runs every in-scope rule over one file's source. rel must be the
// slash-separated path relative to the tree root, because Scope matching and
// the reported File both derive from it.
func CheckSource(fset *token.FileSet, rel string, src []byte) []Violation {
	return checkSourceWith(Rules, fset, rel, src)
}

// checkSourceWith is CheckSource against an explicit rule set rather than the
// global registry, so one rule's tests can run it in isolation instead of
// tripping over violations from fixtures written for a sibling rule.
func checkSourceWith(rules []Rule, fset *token.FileSet, rel string, src []byte) []Violation {
	f, err := parser.ParseFile(fset, rel, src, parser.ParseComments)
	if err != nil {
		return []Violation{{Rule: "parse", File: rel, Line: 0, Msg: err.Error()}}
	}

	allowed, out := allowIndex(f, fset, rel)

	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}

	for _, r := range rules {
		if !r.inScope(dir) {
			continue
		}
		for _, v := range r.Check(f, fset, rel) {
			// Keyed on v.Rule (what the rule actually emits), not r.ID: a
			// rule that reports a sub-id would otherwise require an allow
			// comment naming an id nobody prints.
			if allowed[v.Line][v.Rule] {
				continue
			}
			out = append(out, v)
		}
	}
	return out
}

// skipDirs are never descended into, for two different reasons: dbgen and
// vendor hold generated/vendored code governed by their own generator or
// upstream, not by these rules; testdata and data hold non-source content --
// test fixtures, and (for data, Server/data/) gitignored runtime state such
// as the SQLite db, certs and uploads -- with no Go files to check.
var skipDirs = map[string]bool{
	"dbgen":    true,
	"vendor":   true,
	"testdata": true,
	"data":     true,
}

// Run parses every non-test .go file under root and returns every violation,
// sorted by file then line so failures are deterministic.
//
// The tree is walked through os.Root, which confines every read to root and
// cannot be escaped by a symlink. That also makes the walk paths slash-
// separated and already relative to root, which is exactly the form
// CheckSource and Violation.File want.
func Run(root string) ([]Violation, error) {
	return runWith(Rules, root)
}

// runWith is Run against an explicit rule set rather than the global registry
// — the walker counterpart of checkSourceWith, so one rule's tests can sweep
// the real tree in isolation.
func runWith(rules []Rule, root string) ([]Violation, error) {
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = r.Close()
	}()
	rfs := r.FS()

	fset := token.NewFileSet()
	var out []Violation

	err = fs.WalkDir(rfs, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Never skip the root itself: its name is ".", which would
			// otherwise match the dot-prefix test and abort the whole walk.
			if p == "." {
				return nil
			}
			if skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		src, err := fs.ReadFile(rfs, p)
		if err != nil {
			return err
		}
		out = append(out, checkSourceWith(rules, fset, p, src)...)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Stable: two violations can share a file:line (an allow comment with no
	// reason produces exactly that, alongside the rule it failed to
	// suppress), and sort.Slice does not promise to preserve their order.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	return out, nil
}
