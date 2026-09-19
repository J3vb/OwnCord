package invariants

import (
	"go/ast"
	"path"
	"strconv"
	"strings"
)

// The *db.DB receiver analysis, in one place. db-import-boundary checks a
// single file with it and Server/cmd/dbinventory measures the whole tree with
// it; until B6-14 the command carried its own copy, so a shape the inventory
// could see was not necessarily a shape the guard could, and neither of them
// said so.
//
// Syntactic, like every rule in this package: no type information. A *db.DB
// value is recognised as an identifier declared *db.DB in the same file
// (parameter, result, var, or a name assigned from db.Open*), or a selector
// whose final field is declared *db.DB anywhere in the same package (h.db,
// s.deps.DB). A handle reached through an interface-typed field and called
// through it is the one shape this cannot see; Hands names every place such a
// field could be given the handle in the first place.

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

// isDBPtr reports whether expr is *<alias>.DB. An empty alias matches nothing,
// which is what a file that does not import db must get.
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
// in the file. The caller unions these across a package, because the field is
// declared in one file (ws/hub.go) and read in every other.
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
// own openers. A composition root reaches the handle through one of these
// (`database, err := openDatabase(cfg)`) far more often than through db.Open*
// directly, and the caller is usually a file that imports nothing from db at
// all. The caller unions these across a package, like DBHandleFields, because
// the constructor is declared in one file and called from another. Methods are
// left out: a receiver's package cannot be known without type information.
//
// The index, not just the name: a call's results bind to the names on the left
// by position, so it is openDatabase returning (*db.DB, error) that makes
// `database, err :=` put the handle in `database`. Registered as a bare name,
// a constructor returning its handle second would bind the error name as the
// handle and leave the handle itself unmeasured.
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
// results, struct fields, vars, and names assigned from something that carries
// the handle — a db.Open* call, one of the package's *db.DB fields, or one of
// the package's own constructors. `database := opts.DB` and `database, err :=
// openDatabase(cfg)` carry the handle just as much as a declared parameter
// does, and not following it there would let a file call or hand on the handle
// under a new name. fields and ctors may be nil, which is what a caller with no
// package-wide view (the per-file rule) passes.
func DBHandleVars(f *ast.File, alias string, fields map[string]bool, ctors map[string]int) map[string]bool {
	vars := map[string]bool{}
	add := func(names []*ast.Ident) {
		for _, n := range names {
			vars[n.Name] = true
		}
	}
	// bind names the left-hand side that receives the handle. A call is one
	// expression standing for several results, so a single right-hand
	// expression zips against every name it produces; otherwise the two lists
	// pair up by position.
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

// handleCarrier reports whether the right-hand side of a declaration or an
// assignment yields the handle at result position i. db.Open* is
// (*db.DB, error) and a field read yields a single value, so both yield the
// handle at position 0; a package constructor yields it wherever its own
// result list puts it — which is the whole reason ctors carries an index.
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

// DBHandleCalls tallies two different uses of the handle into two multisets,
// either of which may be nil:
//
//   - calls: every method call whose receiver is a *db.DB identifier or a
//     *db.DB struct field (h.db.DeleteEventsForUser -> DeleteEventsForUser).
//   - hands: every place the file gives the bare handle away. Reading it out
//     of a struct field (h.db) and passing it on — as a call argument, a
//     struct-literal field, or the target of an assignment — is a hand-off
//     wherever it goes: the handle has left its carrier. A *db.DB
//     local or parameter is a hand-off only when it is passed to another
//     package (pkg.Func(...), pkg.Type{...}): threading a parameter on to a
//     function or method of this same package hands it to nobody the row does
//     not already name. Callees in the db package itself are never hand-offs —
//     that is the handle's own package, not an owner.
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

// dbHandleScan carries one file's worth of context for DBHandleCalls, so the
// two node shapes it recognises can be read one at a time.
type dbHandleScan struct {
	pkgs    map[string]bool
	dbAlias string
	vars    map[string]bool
	fields  map[string]bool
	calls   map[string]int
	hands   map[string]int
}

// ownPkg reports whether a callee or a composite-literal type names the db
// package itself. Checked on the callee rather than on the argument, because
// the argument's shape is what differs (h.db is a hand-off wherever it goes, a
// local only across a package boundary) while the exclusion is the same for
// both.
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
// `holder.Store = h.db`. The handle has left its carrier, and the row can
// still name where it went — the field's path — which is what a call argument
// gives up when the callee is a value whose package and type are unknown. The
// destination must be a field and not a name: `database := h.db` is the same
// handle under a new name in this file, which DBHandleVars tracks as a local
// rather than a hand-off. A local on the right is not one here for the same
// reason it is not one as an argument — the destination's package, and whether
// the destination is a different one at all, cannot be known.
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
// "h.computeAllowedChannels" (no — same package, or a method on a value whose
// package cannot be known without type information).
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
