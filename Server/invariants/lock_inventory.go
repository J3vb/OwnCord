package invariants

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"regexp"
	"sort"
	"strings"
)

// lockInventoryID is the rule's stable id. Like syncutilLocksID it is a const
// so the Rule var's initializer does not form a cycle with the function that
// emits it.
const lockInventoryID = "lock-inventory"

const (
	lockInventoryDir   = "ws"
	lockOrderFile      = "ws/lock_order.go"
	syncutilImportPath = "github.com/J3vb/OwnCord/Server/syncutil"
)

// lockInventory requires every mutex declared in package ws to be named in
// the rank table of ws/lock_order.go.
//
// lock_order.go is the one written lock order. Nothing checked that it listed
// the locks that exist, so a new mutex (or a renamed one) joined the hub
// without a rank and the order silently stopped being complete. This rule
// compares the two in both directions: a lock in the code with no row, and a
// row naming a lock that is gone.
//
// A lock is a struct field, package-level var, function-local var or short
// declaration whose type is syncutil.Mutex/RWMutex (or sync.Mutex/RWMutex,
// which syncutil-locks forbids in ws but which is still a lock if one slips
// in). A field is named Type.field after the struct that declares it, so an
// embedded state's lock is activityState.mu, not Hub.activity.mu; a package
// var or local is named by its identifier (admissionMu).
//
// Cross-file, so it uses Tree rather than Check. It has no
// //invariant:allow escape: an exempt lock is a row ranked "-" with an
// "unranked: <reason>" in the table, which is where a reader looks.
var lockInventory = Rule{
	ID:    lockInventoryID,
	Scope: []string{lockInventoryDir},
	Tree:  checkLockInventoryTree,
}

// lockRowRE matches one table row of lock_order.go: a tab, a rank (a number or
// -), an optional S serialiser mark, then the lock name. Continuation lines
// are indented past the tab and never match.
var lockRowRE = regexp.MustCompile(`^\t(\d+|-)(?: S)?\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)(?:\s|$)`)

// lockDecl is one lock found in the code.
type lockDecl struct {
	name string // Type.field, or the identifier of a var/local
	file string
	line int
}

// lockRow is one table row.
type lockRow struct {
	name string
	line int
	rank string // "9", or "-"
	text string // the whole row, for the unranked: check
}

// checkLockInventoryTree reads the non-test files of ws/ from fsys.
func checkLockInventoryTree(fsys fs.FS) []Violation {
	entries, err := fs.ReadDir(fsys, lockInventoryDir)
	if err != nil {
		return []Violation{{Rule: lockInventoryID, File: lockInventoryDir, Msg: "reading ws/: " + err.Error()}}
	}
	files := make(map[string][]byte)
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		src, err := fs.ReadFile(fsys, lockInventoryDir+"/"+n)
		if err != nil {
			return []Violation{{Rule: lockInventoryID, File: lockInventoryDir + "/" + n, Msg: err.Error()}}
		}
		files[lockInventoryDir+"/"+n] = src
	}
	return checkLockInventory(files)
}

// checkLockInventory is the rule over in-memory sources keyed by slash path,
// so tests can feed snippets. The table is read from files[lockOrderFile].
func checkLockInventory(files map[string][]byte) []Violation {
	fset := token.NewFileSet()
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	var out []Violation
	var decls []lockDecl
	var rows []lockRow
	sawTable := false
	for _, p := range paths {
		f, err := parser.ParseFile(fset, p, files[p], parser.ParseComments)
		if err != nil {
			out = append(out, Violation{Rule: lockInventoryID, File: p, Msg: "parse: " + err.Error()})
			continue
		}
		if p == lockOrderFile {
			sawTable = true
			rows = lockTableRows(f, fset)
		}
		decls = append(decls, lockDecls(f, fset, p)...)
	}

	if !sawTable {
		return append(out, Violation{Rule: lockInventoryID, File: lockOrderFile,
			Msg: lockOrderFile + " is missing; the lock-order table lives there"})
	}
	if len(rows) == 0 {
		return append(out, Violation{Rule: lockInventoryID, File: lockOrderFile,
			Msg: "no table rows found in " + lockOrderFile + "; a row is a tab, a rank (or -), and the lock as Type.field"})
	}

	inTable := make(map[string]bool, len(rows))
	for _, r := range rows {
		inTable[r.name] = true
		if r.rank == "-" && !hasUnrankedReason(r.text) {
			out = append(out, Violation{Rule: lockInventoryID, File: lockOrderFile, Line: r.line,
				Msg: fmt.Sprintf("row for %s has no rank; give it a rank number, or write \"unranked: <reason>\" on the row", r.name)})
		}
	}
	inCode := make(map[string]bool, len(decls))
	for _, d := range decls {
		inCode[d.name] = true
		if inTable[d.name] {
			continue
		}
		out = append(out, Violation{Rule: lockInventoryID, File: d.file, Line: d.line,
			Msg: fmt.Sprintf("lock %s is not in the lock-order table; add a row to %s naming it as Type.field "+
				"(a package-level or local lock by its identifier) with a rank, or \"unranked: <reason>\"", d.name, lockOrderFile)})
	}
	for _, r := range rows {
		if inCode[r.name] {
			continue
		}
		out = append(out, Violation{Rule: lockInventoryID, File: lockOrderFile, Line: r.line,
			Msg: fmt.Sprintf("stale row: no mutex named %s is declared in non-test files of ws/; "+
				"delete the row, or fix its name if the lock was renamed (Type.field)", r.name)})
	}
	return out
}

func hasUnrankedReason(row string) bool {
	_, reason, ok := strings.Cut(row, "unranked:")
	return ok && strings.TrimSpace(reason) != ""
}

// lockTableRows reads the rank table out of every comment in the file.
func lockTableRows(f *ast.File, fset *token.FileSet) []lockRow {
	var rows []lockRow
	for _, g := range f.Comments {
		for _, c := range g.List {
			if !strings.HasPrefix(c.Text, "//") {
				continue
			}
			text := strings.TrimPrefix(c.Text, "//")
			m := lockRowRE.FindStringSubmatch(text)
			if m == nil {
				continue
			}
			rows = append(rows, lockRow{name: m[2], line: fset.Position(c.Slash).Line, rank: m[1], text: text})
		}
	}
	return rows
}

// lockScan holds the per-file state of the declaration scan.
type lockScan struct {
	names map[string]bool // local names bound to sync and syncutil
	fset  *token.FileSet
	rel   string
	named map[*ast.StructType]string
	out   []lockDecl
}

// lockDecls finds every mutex declaration in one file.
func lockDecls(f *ast.File, fset *token.FileSet, rel string) []lockDecl {
	syncNames, _ := importNames(f, "sync")
	utilNames, _ := importNames(f, syncutilImportPath)
	names := make(map[string]bool)
	for n := range syncNames {
		names[n] = true
	}
	for n := range utilNames {
		names[n] = true
	}
	if len(names) == 0 {
		return nil
	}
	s := &lockScan{names: names, fset: fset, rel: rel, named: make(map[*ast.StructType]string)}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.TypeSpec:
			s.typeSpec(x)
		case *ast.StructType:
			s.structType(x)
		case *ast.ValueSpec:
			s.valueSpec(x)
		case *ast.AssignStmt:
			s.assign(x)
		}
		return true
	})
	return s.out
}

func (s *lockScan) add(name string, pos token.Pos) {
	s.out = append(s.out, lockDecl{name: name, file: s.rel, line: s.fset.Position(pos).Line})
}

func (s *lockScan) isMutexSel(e ast.Expr) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok || (sel.Sel.Name != "Mutex" && sel.Sel.Name != "RWMutex") {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && s.names[id.Name]
}

// holdsLock reports whether a type expression contains a mutex at any depth
// ([]syncutil.Mutex, map[K]*syncutil.Mutex), but not inside a struct body,
// whose fields are reported on their own.
func (s *lockScan) holdsLock(e ast.Expr) bool {
	found := false
	ast.Inspect(e, func(n ast.Node) bool {
		if _, ok := n.(*ast.StructType); ok {
			return false
		}
		if x, ok := n.(ast.Expr); ok && s.isMutexSel(x) {
			found = true
		}
		return !found
	})
	return found
}

// valueIsLock covers `mu := syncutil.Mutex{}`, `&syncutil.Mutex{}` and
// `new(syncutil.Mutex)`, where the declaration carries no type.
func (s *lockScan) valueIsLock(e ast.Expr) bool {
	if u, ok := e.(*ast.UnaryExpr); ok && u.Op == token.AND {
		e = u.X
	}
	switch v := e.(type) {
	case *ast.CompositeLit:
		return v.Type != nil && s.holdsLock(v.Type)
	case *ast.CallExpr:
		id, ok := v.Fun.(*ast.Ident)
		return ok && id.Name == "new" && len(v.Args) == 1 && s.isMutexSel(v.Args[0])
	}
	return false
}

func (s *lockScan) typeSpec(x *ast.TypeSpec) {
	if st, ok := x.Type.(*ast.StructType); ok {
		s.named[st] = x.Name.Name
		return
	}
	if s.holdsLock(x.Type) {
		s.add(x.Name.Name, x.Pos())
	}
}

// structType reports the lock fields of one struct. A struct that is not the
// body of a type declaration has no name to build Type.field from; its fields
// are reported under a placeholder so the row cannot match and the author
// names the struct.
func (s *lockScan) structType(x *ast.StructType) {
	owner, ok := s.named[x]
	if !ok {
		owner = "<anonymous struct>"
	}
	for _, fld := range x.Fields.List {
		if !s.holdsLock(fld.Type) {
			continue
		}
		if len(fld.Names) == 0 { // embedded: the field is named for the type
			s.add(owner+"."+embeddedName(fld.Type), fld.Pos())
		}
		for _, nm := range fld.Names {
			s.add(owner+"."+nm.Name, nm.Pos())
		}
	}
}

func (s *lockScan) valueSpec(x *ast.ValueSpec) {
	for i, nm := range x.Names {
		typed := x.Type != nil && s.holdsLock(x.Type)
		if typed || (i < len(x.Values) && s.valueIsLock(x.Values[i])) {
			s.add(nm.Name, nm.Pos())
		}
	}
}

func (s *lockScan) assign(x *ast.AssignStmt) {
	if x.Tok != token.DEFINE {
		return
	}
	for i, lhs := range x.Lhs {
		if id, ok := lhs.(*ast.Ident); ok && i < len(x.Rhs) && s.valueIsLock(x.Rhs[i]) {
			s.add(id.Name, id.Pos())
		}
	}
}

// embeddedName is the field name Go gives an embedded type: its base name.
func embeddedName(e ast.Expr) string {
	switch t := e.(type) {
	case *ast.StarExpr:
		return embeddedName(t.X)
	case *ast.SelectorExpr:
		return t.Sel.Name
	case *ast.Ident:
		return t.Name
	default:
		return "?"
	}
}
