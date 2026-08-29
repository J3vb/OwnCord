// Command dbinventory lists every production Go file above the domain layer
// that imports the db package, and what it uses it for: db.* types, db.*
// package functions and sentinels, and method calls on a *db.DB value.
//
// It is the measurement behind docs/architecture/server-boundaries.md (B3-0)
// and prints a Markdown table so the document can be regenerated:
//
//	cd Server && go run ./cmd/dbinventory
//
// The analysis is syntactic (go/parser + go/ast, no type information), like
// Server/invariants: a *db.DB method call is recognised when the receiver is
// an identifier declared with type *db.DB in the same file (parameter, result,
// var, or a name assigned from db.Open*), or a selector whose final field is
// declared *db.DB anywhere in the same package (h.db.X, s.deps.DB.X). That
// covers every shape in the tree today; a new shape shows up as a file with
// an import and no recorded use, which is itself a row worth reading.
package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/J3vb/OwnCord/Server/invariants"
)

const dbImportPath = "github.com/J3vb/OwnCord/Server/db"

// skipDirs are never inventoried: db and service are the layers that may
// import db; dbgen is generated; testdata holds fixtures, not code.
var skipDirs = map[string]bool{"db": true, "service": true, "dbgen": true, "testdata": true, "node_modules": true}

type kind int

const (
	kindType kind = iota
	kindFunc
	kindValue // var or const, e.g. sentinel errors
)

type fileUse struct {
	rel     string
	types   map[string]int
	funcs   map[string]int
	values  map[string]int
	methods map[string]int
}

func main() {
	root := flag.String("root", ".", "Server module root")
	flag.Parse()

	fset := token.NewFileSet()
	dbKinds, err := declKinds(fset, filepath.Join(*root, "db"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	files, err := productionFiles(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	// Pass 1: parse everything, collect struct fields typed *db.DB per package.
	parsed := map[string]*ast.File{}
	fieldsByPkg := map[string]map[string]bool{}
	for _, rel := range files {
		f, err := parser.ParseFile(fset, filepath.Join(*root, rel), nil, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		parsed[rel] = f
		alias := dbAlias(f)
		if alias == "" {
			continue
		}
		dir := path.Dir(rel)
		if fieldsByPkg[dir] == nil {
			fieldsByPkg[dir] = map[string]bool{}
		}
		for name := range dbDBFields(f, alias) {
			fieldsByPkg[dir][name] = true
		}
	}

	// Pass 2: per-file uses.
	var rows []fileUse
	for _, rel := range files {
		f := parsed[rel]
		alias := dbAlias(f)
		if alias == "" {
			continue
		}
		rows = append(rows, analyze(f, rel, alias, dbKinds, fieldsByPkg[path.Dir(rel)]))
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].rel < rows[j].rel })
	printTable(rows)
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
			if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
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

// dbAlias returns the local name the file imports the db package under, or
// "" if it does not import it.
func dbAlias(f *ast.File) string {
	for _, imp := range f.Imports {
		if strings.Trim(imp.Path.Value, `"`) != dbImportPath {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return "db"
	}
	return ""
}

// isDBPtr reports whether expr is *<alias>.DB.
func isDBPtr(expr ast.Expr, alias string) bool {
	star, ok := expr.(*ast.StarExpr)
	if !ok {
		return false
	}
	sel, ok := star.X.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	x, ok := sel.X.(*ast.Ident)
	return ok && x.Name == alias && sel.Sel.Name == "DB"
}

// dbDBFields returns the names of struct fields typed *db.DB in the file.
func dbDBFields(f *ast.File, alias string) map[string]bool {
	out := map[string]bool{}
	ast.Inspect(f, func(n ast.Node) bool {
		st, ok := n.(*ast.StructType)
		if !ok {
			return true
		}
		for _, fld := range st.Fields.List {
			if isDBPtr(fld.Type, alias) {
				for _, name := range fld.Names {
					out[name.Name] = true
				}
			}
		}
		return true
	})
	return out
}

func analyze(f *ast.File, rel, alias string, dbKinds map[string]kind, dbFields map[string]bool) fileUse {
	u := fileUse{rel: rel, types: map[string]int{}, funcs: map[string]int{}, values: map[string]int{}, methods: map[string]int{}}
	dbVars := collectDBVars(f, alias)
	countMethodCalls(f, dbVars, dbFields, u.methods)
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

// collectDBVars returns identifiers declared with type *db.DB: params,
// results, struct fields, vars, and names assigned from a db.Open* call.
func collectDBVars(f *ast.File, alias string) map[string]bool {
	dbVars := map[string]bool{}
	add := func(names []*ast.Ident) {
		for _, n := range names {
			dbVars[n.Name] = true
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.Field:
			if isDBPtr(x.Type, alias) {
				add(x.Names)
			}
		case *ast.ValueSpec:
			if x.Type != nil && isDBPtr(x.Type, alias) {
				add(x.Names)
			}
		case *ast.AssignStmt:
			for i, rhs := range x.Rhs {
				if openAssign(rhs, alias) && i < len(x.Lhs) {
					if id, ok := x.Lhs[i].(*ast.Ident); ok {
						dbVars[id.Name] = true
					}
				}
			}
		}
		return true
	})
	return dbVars
}

// openAssign reports whether expr is a call to <alias>.Open*(...).
func openAssign(expr ast.Expr, alias string) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok {
		return false
	}
	name, ok := pkgSelector(call.Fun, alias)
	return ok && strings.HasPrefix(name, "Open")
}

// countMethodCalls tallies calls whose receiver is a *db.DB identifier or a
// selector ending in a *db.DB struct field.
func countMethodCalls(f *ast.File, dbVars, dbFields map[string]bool, methods map[string]int) {
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		switch x := sel.X.(type) {
		case *ast.Ident:
			if dbVars[x.Name] {
				methods[sel.Sel.Name]++
			}
		case *ast.SelectorExpr:
			if dbFields[x.Sel.Name] {
				methods[sel.Sel.Name]++
			}
		}
		return true
	})
}

// classifySelectors buckets every <alias>.X selector by what db declares X as.
func classifySelectors(f *ast.File, alias string, dbKinds map[string]kind, u *fileUse) {
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
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
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

func printTable(rows []fileUse) {
	byPkg := map[string]int{}
	byDisposition := map[string]int{}
	byFamily := map[string]int{}
	typeOnly, unlisted := 0, 0
	fmt.Println("| File | `db.*` types | `db.*` funcs and sentinels | `*db.DB` method calls | Shape | Disposition | Family | Why |")
	fmt.Println("| --- | --- | --- | --- | --- | --- | --- | --- |")
	for _, r := range rows {
		byPkg[path.Dir(r.rel)]++
		shape := "calls"
		if sum(r.funcs)+sum(r.values)+sum(r.methods) == 0 {
			shape = "type-only"
			typeOnly++
		}
		entry, listed := invariants.DBImportAllow[r.rel]
		if !listed {
			unlisted++
			entry = invariants.DBImportEntry{Disposition: "**UNLISTED**", Note: "fails db-import-boundary"}
		}
		byDisposition[entry.Disposition]++
		if entry.Family != "" {
			byFamily[entry.Family]++
		}
		family := entry.Family
		if family == "" {
			family = "—"
		}
		fmt.Printf("| `%s` | %s | %s | %s | %s | %s | %s | %s |\n",
			r.rel, joined(r.types), mergeFV(r), joined(r.methods), shape, entry.Disposition, family, entry.Note)
	}
	fmt.Printf("\n%d files import `db` outside `db/` and `service/` (%s); %d are type-only; %d unlisted.\n",
		len(rows), countList(byPkg), typeOnly, unlisted)
	fmt.Printf("Dispositions: %s. Move targets: %s.\n", countList(byDisposition), countList(byFamily))
	stale := 0
	present := map[string]bool{}
	for _, r := range rows {
		present[r.rel] = true
	}
	for rel := range invariants.DBImportAllow {
		if !present[rel] {
			stale++
			fmt.Printf("STALE allowlist row (file no longer imports db): `%s`\n", rel)
		}
	}
	if unlisted > 0 || stale > 0 {
		os.Exit(1)
	}
}

// countList renders a count map as "a 1, b 2", keys sorted.
func countList(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
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
