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
var Rules = []Rule{syncutilLocks}

// allowPrefix introduces a line-scoped suppression:
//
//	mu sync.Mutex //invariant:allow syncutil-locks — <reason>
//
// The reason is mandatory. An allow comment without one does not suppress
// anything and is itself reported, so the hatch cannot silently disable a rule.
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
	f, err := parser.ParseFile(fset, rel, src, parser.ParseComments)
	if err != nil {
		return []Violation{{Rule: "parse", File: rel, Line: 0, Msg: err.Error()}}
	}

	allowed, out := allowIndex(f, fset, rel)

	dir := path.Dir(rel)
	if dir == "." {
		dir = ""
	}

	for _, r := range Rules {
		if !r.inScope(dir) {
			continue
		}
		for _, v := range r.Check(f, fset, rel) {
			if allowed[v.Line][r.ID] {
				continue
			}
			out = append(out, v)
		}
	}
	return out
}

// skipDirs are never descended into. Generated trees are governed by their
// generator, not by these rules.
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
		out = append(out, CheckSource(fset, p, src)...)
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].File != out[j].File {
			return out[i].File < out[j].File
		}
		return out[i].Line < out[j].Line
	})
	return out, nil
}
