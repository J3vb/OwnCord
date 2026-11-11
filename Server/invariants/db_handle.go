package invariants

import (
	"go/ast"
	"path"
	"strconv"
	"strings"
)

// The *db.DB receiver analysis, shared by db-import-boundary (one file) and
// Server/cmd/dbinventory (the whole tree), so the guard and the inventory see
// the same shapes.
//
// Syntactic, like every rule here: no type information. A *db.DB value is an
// identifier declared *db.DB in the same file (parameter, result, var, or a
// name assigned from db.Open*), or a selector whose final field is declared
// *db.DB anywhere in the same package (h.db). A handle reached through an
// interface-typed field is the one shape this cannot see; Hands names every
// place such a field could be given the handle.

// DBHandleAlias returns the local name the file imports Server/db under, or ""
// when it does not import it.
func DBHandleAlias(f *ast.File) string {
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil || p != dbImportPath {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return "db"
	}
	return ""
}

// isDBPtr reports whether expr is *<alias>.DB; an empty alias matches nothing.
func isDBPtr(expr ast.Expr, alias string) bool {
	if alias == "" {
		return false
	}
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

// DBHandleFields returns the names of struct fields typed *<alias>.DB declared
// in the file; the caller unions them across a package.
func DBHandleFields(f *ast.File, alias string) map[string]bool {
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

// DBHandleCtors returns, for each package-level function in the file whose
// result list contains a *<alias>.DB, the index of that result: the package's
// own openers (`database, err := openDatabase(cfg)`), which a composition root
// reaches the handle through far more often than through db.Open*. The caller
// unions them across a package. Methods are left out: a receiver's package
// cannot be known without type information.
//
// The index matters because results bind to the left-hand names by position;
// a bare name would bind the error name as the handle for a constructor
// returning its handle second.
func DBHandleCtors(f *ast.File, alias string) map[string]int {
	out := map[string]int{}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || fn.Type.Results == nil {
			continue
		}
		i := 0
		for _, res := range fn.Type.Results.List {
			width := len(res.Names)
			if width == 0 {
				width = 1 // an unnamed result still occupies a position
			}
			if isDBPtr(res.Type, alias) {
				out[fn.Name.Name] = i
				break
			}
			i += width
		}
	}
	return out
}

// DBHandleVars returns identifiers declared with type *<alias>.DB: params,
// results, struct fields, vars, and names assigned from something carrying the
// handle (a db.Open* call, a package *db.DB field, or a package constructor),
// since following it keeps a rename from hiding a call or hand-off. fields and
// ctors may be nil, as in the per-file rule.
func DBHandleVars(f *ast.File, alias string, fields map[string]bool, ctors map[string]int) map[string]bool {
	vars := map[string]bool{}
	add := func(names []*ast.Ident) {
		for _, n := range names {
			vars[n.Name] = true
		}
	}
	// bind names the left-hand side that receives the handle. One right-hand
	// call zips against every name it produces; otherwise lists pair by position.
	bind := func(lhs, rhs []ast.Expr) {
		if len(rhs) != 1 && len(rhs) != len(lhs) {
			return
		}
		for i, l := range lhs {
			r := rhs[0]
			if len(rhs) > 1 {
				r = rhs[i]
			}
			if !handleCarrier(r, i, alias, fields, ctors) {
				continue
			}
			if id, ok := l.(*ast.Ident); ok {
				vars[id.Name] = true
			}
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.Field:
			if isDBPtr(x.Type, alias) {
				add(x.Names)
			}
		case *ast.ValueSpec:
			if x.Type != nil {
				if isDBPtr(x.Type, alias) {
					add(x.Names)
				}
				return true
			}
			// var d = h.db — no written type, same carrier.
			bind(identExprs(x.Names), x.Values)
		case *ast.AssignStmt:
			bind(x.Lhs, x.Rhs)
		}
		return true
	})
	return vars
}

// identExprs adapts a ValueSpec's names to the expression list bind takes.
func identExprs(names []*ast.Ident) []ast.Expr {
	out := make([]ast.Expr, len(names))
	for i, n := range names {
		out[i] = n
	}
	return out
}

// handleCarrier reports whether the right-hand side yields the handle at result
// position i: db.Open* and a field read yield it at 0, a package constructor
// wherever its result list puts it (hence ctors carries an index).
func handleCarrier(rhs ast.Expr, i int, alias string, fields map[string]bool, ctors map[string]int) bool {
	if openAssign(rhs, alias) {
		return i == 0
	}
	switch x := rhs.(type) {
	case *ast.SelectorExpr:
		return i == 0 && fields[x.Sel.Name]
	case *ast.CallExpr:
		id, ok := x.Fun.(*ast.Ident)
		if !ok {
			return false
		}
		at, isCtor := ctors[id.Name]
		return isCtor && at == i
	}
	return false
}

// openAssign reports whether expr is a call to <alias>.Open*(...).
func openAssign(expr ast.Expr, alias string) bool {
	call, ok := expr.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok || alias == "" || pkg.Name != alias {
		return false
	}
	return strings.HasPrefix(sel.Sel.Name, "Open")
}

// DBHandleCalls tallies two uses of the handle into two multisets, either of which may be nil:
//
//   - calls: every method call whose receiver is a *db.DB identifier or
//     struct field (h.db.DeleteEventsForUser -> DeleteEventsForUser).
//   - hands: every place the file gives the bare handle away. Reading it out of
//     a struct field and passing it on (as a call argument, struct-literal
//     field, or assignment target) is a hand-off wherever it goes. A *db.DB
//     local or parameter is a hand-off only when passed to another package:
//     threading it through this package hands it to nobody the row does not
//     already name. Callees in the db package itself are never hand-offs.
func DBHandleCalls(f *ast.File, vars, fields map[string]bool, calls, hands map[string]int) {
	s := dbHandleScan{
		pkgs:    importedNames(f),
		dbAlias: DBHandleAlias(f),
		vars:    vars,
		fields:  fields,
		calls:   calls,
		hands:   hands,
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			s.assignStmt(x)
		case *ast.CallExpr:
			s.callExpr(x)
		case *ast.CompositeLit:
			s.compositeLit(x)
		}
		return true
	})
}

// dbHandleScan carries one file's context for DBHandleCalls.
type dbHandleScan struct {
	pkgs    map[string]bool
	dbAlias string
	vars    map[string]bool
	fields  map[string]bool
	calls   map[string]int
	hands   map[string]int
}

// ownPkg reports whether a callee or composite-literal type names the db
// package itself, checked on the callee because the exclusion is the same for
// both argument shapes.
func (s dbHandleScan) ownPkg(e ast.Expr) bool {
	if s.dbAlias == "" {
		return false
	}
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == s.dbAlias
}

// handed reports whether an argument is the bare handle leaving its carrier.
func (s dbHandleScan) handed(arg ast.Expr, crossPkg bool) bool {
	switch a := arg.(type) {
	case *ast.SelectorExpr:
		return s.fields[a.Sel.Name]
	case *ast.Ident:
		return crossPkg && s.vars[a.Name]
	}
	return false
}

// callExpr tallies a method call on the handle and any hand-off among its
// arguments.
func (s dbHandleScan) callExpr(x *ast.CallExpr) {
	if sel, ok := x.Fun.(*ast.SelectorExpr); ok && s.calls != nil {
		switch recv := sel.X.(type) {
		case *ast.Ident:
			if s.vars[recv.Name] {
				s.calls[sel.Sel.Name]++
			}
		case *ast.SelectorExpr:
			if s.fields[recv.Sel.Name] {
				s.calls[sel.Sel.Name]++
			}
		}
	}
	if s.hands == nil || s.ownPkg(x.Fun) {
		return
	}
	name, crossPkg := calleeName(x.Fun, s.pkgs)
	for _, arg := range x.Args {
		if s.handed(arg, crossPkg) {
			s.hands[name]++
		}
	}
}

// compositeLit tallies a hand-off through a struct literal field.
func (s dbHandleScan) compositeLit(x *ast.CompositeLit) {
	if s.hands == nil || s.ownPkg(x.Type) {
		return
	}
	name, crossPkg := qualifiedName(x.Type, s.pkgs)
	for _, elt := range x.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if s.handed(kv.Value, crossPkg) {
			s.hands[name]++
		}
	}
}

// assignStmt tallies a hand-off through an assignment into a field:
// `holder.Store = h.db`. The row can still name the destination field's path.
// The destination must be a field: `database := h.db` is the same handle under
// a new name, tracked by DBHandleVars. A local on the right is not a hand-off,
// as for an argument, since the destination's package cannot be known.
func (s dbHandleScan) assignStmt(x *ast.AssignStmt) {
	if s.hands == nil || len(x.Lhs) != len(x.Rhs) {
		return
	}
	for i, lhs := range x.Lhs {
		if _, ok := lhs.(*ast.SelectorExpr); !ok {
			continue
		}
		if !s.handed(x.Rhs[i], false) {
			continue
		}
		name, _ := qualifiedName(lhs, s.pkgs)
		s.hands[name]++
	}
}

// calleeName renders a call's target for the Hands column and reports whether
// it names another package: "ws.NewEventPersister" (yes), "subjectFor" or
// "h.computeAllowedChannels" (no).
func calleeName(fun ast.Expr, pkgs map[string]bool) (string, bool) {
	if id, ok := fun.(*ast.Ident); ok {
		return id.Name, false
	}
	return qualifiedName(fun, pkgs)
}

// qualifiedName renders a selector or a composite-literal type as "x.Y" and
// reports whether x is one of the file's imported package names.
func qualifiedName(e ast.Expr, pkgs map[string]bool) (string, bool) {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		if id, ok := e.(*ast.Ident); ok {
			return id.Name, false
		}
		return "?", false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return "?." + sel.Sel.Name, false
	}
	return id.Name + "." + sel.Sel.Name, pkgs[id.Name]
}

// importedNames returns every local identifier the file binds to an import.
// Blank and dot imports bind no usable qualifier and are left out.
func importedNames(f *ast.File) map[string]bool {
	out := map[string]bool{}
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			continue
		}
		switch {
		case imp.Name == nil:
			out[path.Base(p)] = true
		case imp.Name.Name == "_", imp.Name.Name == ".":
		default:
			out[imp.Name.Name] = true
		}
	}
	return out
}
