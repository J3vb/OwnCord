// Command dbinventory lists every production Go file above the domain layer
// that uses the db package, and what it uses it for: db.* types, db.* package
// functions and sentinels, method calls on a *db.DB value, and the places the
// bare handle is passed on to somebody else.
//
// It is the measurement behind docs/architecture/server-boundaries.md (B3-0)
// and prints a Markdown table so the document can be regenerated:
//
//	cd Server && go run ./cmd/dbinventory
//
// The analysis is syntactic (go/parser + go/ast, no type information) and
// lives in Server/invariants so the guard and this command measure the same
// thing: see DBHandleVars, DBHandleFields and DBHandleCalls.
//
// Use, not import (B6-14). The handle is stored on a struct field — Hub.db,
// App.database — so any file in those packages can call it without importing
// db at all, and until B6-14 the walk skipped every such file and the
// inventory said nothing about them. A file in a package that declares a
// *db.DB field is now analysed whatever it imports, and becomes a row as soon
// as it calls the handle or hands it on.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/J3vb/OwnCord/Server/invariants"
)

// layerDirs are the top-level packages that may import db freely and are
// therefore not inventoried. Matched on the root-relative path, so a nested
// directory that happens to share a name (api/service/) is still inventoried
// — the same rule db-import-boundary applies.
var layerDirs = map[string]bool{"db": true, "service": true}

// skipNames are never code at any depth: fixtures and vendored JS.
var skipNames = map[string]bool{"testdata": true, "node_modules": true}

type kind int

const (
	kindType kind = iota
	kindFunc
	kindValue // var or const, e.g. sentinel errors
)

type fileUse struct {
	rel     string
	imports bool // the file imports db itself, rather than reaching a package field
	types   map[string]int
	funcs   map[string]int
	values  map[string]int
	methods map[string]int
	hands   map[string]int
}

func main() {
	root := flag.String("root", ".", "Server module root")
	flag.Parse()

	rows, err := inventory(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if printTable(os.Stdout, rows, invariants.DBImportAllow) > 0 {
		os.Exit(1)
	}
}

// inventory returns one row per production file under root that imports db,
// sorted by path. Split out of main so the doc gate
// (TestServerBoundariesDocIsCurrent) can render the same block the command
// prints without shelling out to it.
func inventory(root string) ([]fileUse, error) {
	fset := token.NewFileSet()
	dbKinds, err := declKinds(fset, filepath.Join(root, "db"))
	if err != nil {
		return nil, err
	}

	files, err := productionFiles(root)
	if err != nil {
		return nil, err
	}

	// Pass 1: parse everything, collect struct fields typed *db.DB per package.
	parsed := map[string]*ast.File{}
	fieldsByPkg := map[string]map[string]bool{}
	for _, rel := range files {
		f, err := parser.ParseFile(fset, filepath.Join(root, rel), nil, 0)
		if err != nil {
			return nil, err
		}
		parsed[rel] = f
		alias := invariants.DBHandleAlias(f)
		if alias == "" {
			continue
		}
		dir := path.Dir(rel)
		if fieldsByPkg[dir] == nil {
			fieldsByPkg[dir] = map[string]bool{}
		}
		for name := range invariants.DBHandleFields(f, alias) {
			fieldsByPkg[dir][name] = true
		}
	}

	// Pass 2: per-file uses. A file with no import is analysed anyway when its
	// package carries the handle on a field — that is the shape B6-14 was
	// about — and becomes a row only if it actually uses it.
	var rows []fileUse
	for _, rel := range files {
		f := parsed[rel]
		alias := invariants.DBHandleAlias(f)
		fields := fieldsByPkg[path.Dir(rel)]
		if alias == "" && len(fields) == 0 {
			continue
		}
		u := analyze(f, rel, alias, dbKinds, fields)
		if alias == "" && len(u.methods)+len(u.hands) == 0 {
			continue
		}
		rows = append(rows, u)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].rel < rows[j].rel })
	return rows, nil
}

// productionFiles returns slash-separated .go paths under root, excluding
// tests and skipDirs, sorted.
func productionFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p == root {
				return nil
			}
			rel, err := filepath.Rel(root, p)
			if err != nil {
				return err
			}
			if layerDirs[filepath.ToSlash(rel)] || skipNames[d.Name()] || strings.HasPrefix(d.Name(), ".") {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(out)
	return out, err
}

// declKinds parses the db package's production files and maps every exported
// top-level name to its kind, so a db.X selector can be classified exactly.
func declKinds(fset *token.FileSet, dir string) (map[string]kind, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", dir, err)
	}
	kinds := map[string]kind{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, 0)
		if err != nil {
			return nil, fmt.Errorf("parsing %s: %w", name, err)
		}
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				if d.Recv == nil && d.Name.IsExported() {
					kinds[d.Name.Name] = kindFunc
				}
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.TypeSpec:
						if s.Name.IsExported() {
							kinds[s.Name.Name] = kindType
						}
					case *ast.ValueSpec:
						for _, n := range s.Names {
							if n.IsExported() {
								kinds[n.Name] = kindValue
							}
						}
					}
				}
			}
		}
	}
	return kinds, nil
}

func analyze(f *ast.File, rel, alias string, dbKinds map[string]kind, dbFields map[string]bool) fileUse {
	u := fileUse{
		rel: rel, imports: alias != "",
		types: map[string]int{}, funcs: map[string]int{}, values: map[string]int{},
		methods: map[string]int{}, hands: map[string]int{},
	}
	invariants.DBHandleCalls(f, invariants.DBHandleVars(f, alias, dbFields), dbFields, u.methods, u.hands)
	classifySelectors(f, alias, dbKinds, &u)
	return u
}

// pkgSelector returns the selector's field name when expr is <alias>.X.
func pkgSelector(expr ast.Expr, alias string) (string, bool) {
	sel, ok := expr.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok || pkg.Name != alias {
		return "", false
	}
	return sel.Sel.Name, true
}

// classifySelectors buckets every <alias>.X selector by what db declares X as.
// A file with no alias names no db.X selector at all, which is exactly what an
// empty alias yields.
func classifySelectors(f *ast.File, alias string, dbKinds map[string]kind, u *fileUse) {
	if alias == "" {
		return
	}
	ast.Inspect(f, func(n ast.Node) bool {
		expr, ok := n.(ast.Expr)
		if !ok {
			return true
		}
		name, ok := pkgSelector(expr, alias)
		if !ok {
			return true
		}
		switch k, known := dbKinds[name]; {
		case !known:
			u.values["?"+name]++
		case k == kindType:
			u.types[name]++
		case k == kindFunc:
			u.funcs[name]++
		default:
			u.values[name]++
		}
		return true
	})
}

func joined(m map[string]int) string {
	if len(m) == 0 {
		return "—"
	}
	keys := slices.Sorted(maps.Keys(m))
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		if m[k] > 1 {
			parts = append(parts, fmt.Sprintf("%s×%d", k, m[k]))
		} else {
			parts = append(parts, k)
		}
	}
	return "`" + strings.Join(parts, "` `") + "`"
}

func sum(m map[string]int) int {
	n := 0
	for _, v := range m {
		n += v
	}
	return n
}

// printTable renders the Markdown block between the dbinventory markers in
// docs/architecture/server-boundaries.md and returns the number of problems
// found -- nonzero means the command exits 1, and
// TestServerBoundariesDocIsCurrent fails before it compares anything.
//
// The classes, and what each one means:
//
//   - UNLISTED: the file imports db and has no row (B3-0's original).
//   - UNLISTED BY USE: the file imports nothing but reaches the handle through
//     a package field, and has no row. This is the shape B6-14 found: a call
//     the guard could not see because there was no import to see it by.
//   - ADAPTER ROW USES THE HANDLE: an adapter, move or remove row that
//     measures a call or a hand-off. Its disposition says it makes none.
//   - CALLS DRIFTED / HANDS DRIFTED: a boundary row whose pinned multiset is
//     not what the tree measures, in either direction. Raising a count is an
//     edit to DBImportAllow, never a side effect of editing the file.
//   - STALE: a row whose file no longer uses db at all.
//
// allow is a parameter rather than invariants.DBImportAllow directly so the
// unit tests can drive each class from a fixture instead of the live tree.
func printTable(w io.Writer, rows []fileUse, allow map[string]invariants.DBImportEntry) int {
	byPkg := map[string]int{}
	byDisposition := map[string]int{}
	byFamily := map[string]int{}
	typeOnly, noImport, unlisted, problems := 0, 0, 0, 0
	var flagged []string
	_, _ = fmt.Fprintln(w, "| File | `db.*` types | `db.*` funcs and sentinels | `*db.DB` method calls | Hand-offs | Shape | Disposition | Family | Why |")
	_, _ = fmt.Fprintln(w, "| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
	for _, r := range rows {
		byPkg[path.Dir(r.rel)]++
		shape := "calls"
		if sum(r.funcs)+sum(r.values)+sum(r.methods)+sum(r.hands) == 0 {
			shape = "type-only"
			typeOnly++
		}
		if !r.imports {
			noImport++
		}
		entry, listed := allow[r.rel]
		if !listed {
			unlisted++
			entry = invariants.DBImportEntry{Disposition: "**UNLISTED**", Note: "fails db-import-boundary"}
			if !r.imports {
				entry.Note = "uses the handle through a package field and has no row"
			}
		}
		flagged = append(flagged, classify(r, entry, listed)...)
		byDisposition[entry.Disposition]++
		if entry.Family != "" {
			byFamily[entry.Family]++
		}
		family := entry.Family
		if family == "" {
			family = "—"
		}
		_, _ = fmt.Fprintf(w, "| `%s` | %s | %s | %s | %s | %s | %s | %s | %s |\n",
			r.rel, joined(r.types), mergeFV(r), joined(r.methods), joined(r.hands),
			shape, entry.Disposition, family, entry.Note)
	}
	_, _ = fmt.Fprintf(w, "\n%d files use `db` outside `db/` and `service/` (%s); %d import it, "+
		"%d use the handle without importing it; %d are type-only; %d unlisted.\n",
		len(rows), countList(byPkg), len(rows)-noImport, noImport, typeOnly, unlisted)
	_, _ = fmt.Fprintf(w, "Dispositions: %s. Move targets: %s.\n", countList(byDisposition), countList(byFamily))

	present := map[string]bool{}
	for _, r := range rows {
		present[r.rel] = true
	}
	for _, rel := range slices.Sorted(maps.Keys(allow)) {
		if !present[rel] {
			flagged = append(flagged, fmt.Sprintf("STALE allowlist row (file no longer uses db): `%s`", rel))
		}
	}
	for _, line := range flagged {
		problems++
		_, _ = fmt.Fprintln(w, line)
	}
	return problems
}

// classify compares one measured row against the entry that claims it, and
// returns a line per problem found -- naming the file, the measured multiset
// and the pinned one, because "drifted" without both is not actionable.
func classify(r fileUse, entry invariants.DBImportEntry, listed bool) []string {
	if !listed {
		if r.imports {
			return []string{fmt.Sprintf("UNLISTED importer (no allowlist row): `%s`", r.rel)}
		}
		return []string{fmt.Sprintf("UNLISTED BY USE (no import, no allowlist row): `%s` calls %s, hands off %s",
			r.rel, joined(r.methods), joined(r.hands))}
	}
	if entry.Disposition != invariants.DispositionBoundary {
		if sum(r.methods)+sum(r.hands) == 0 {
			return nil
		}
		return []string{fmt.Sprintf("ADAPTER ROW USES THE HANDLE: `%s` is `%s`, which makes no handle use, "+
			"but calls %s and hands off %s", r.rel, entry.Disposition, joined(r.methods), joined(r.hands))}
	}
	var out []string
	if !maps.Equal(entry.Calls, r.methods) {
		out = append(out, fmt.Sprintf("CALLS DRIFTED: `%s` calls %s; the row pins %s",
			r.rel, joined(r.methods), joined(entry.Calls)))
	}
	if !maps.Equal(entry.Hands, r.hands) {
		out = append(out, fmt.Sprintf("HANDS DRIFTED: `%s` hands off %s; the row pins %s",
			r.rel, joined(r.hands), joined(entry.Hands)))
	}
	return out
}

// countList renders a count map as "a 1, b 2", keys sorted.
func countList(m map[string]int) string {
	keys := slices.Sorted(maps.Keys(m))
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s %d", k, m[k]))
	}
	return strings.Join(parts, ", ")
}

func mergeFV(r fileUse) string {
	m := make(map[string]int, len(r.funcs)+len(r.values))
	for k, v := range r.funcs {
		m[k+"()"] = v
	}
	maps.Copy(m, r.values)
	return joined(m)
}
