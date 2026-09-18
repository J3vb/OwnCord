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

// DBHandleCtors returns the names of package-level functions in the file whose
// result list contains a *<alias>.DB: the package's own openers. A composition
// root reaches the handle through one of these (`database, err :=
// openDatabase(cfg)`) far more often than through db.Open* directly, and the
// caller is usually a file that imports nothing from db at all. The caller
// unions these across a package, like DBHandleFields, because the constructor
// is declared in one file and called from another. Methods are left out: a
// receiver's package cannot be known without type information.
func DBHandleCtors(f *ast.File, alias string) map[string]bool {
	out := map[string]bool{}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || fn.Type.Results == nil {
			continue
		}
		for _, res := range fn.Type.Results.List {
			if isDBPtr(res.Type, alias) {
				out[fn.Name.Name] = true
			}
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
func DBHandleVars(f *ast.File, alias string, fields, ctors map[string]bool) map[string]bool {
	vars := map[string]bool{}
	add := func(names []*ast.Ident) {
		for _, n := range names {
			vars[n.Name] = true
		}
	}
	// carries reports whether the right-hand side of a declaration or an
	// assignment yields the handle.
	carries := func(rhs ast.Expr) bool {
		if openAssign(rhs, alias) {
			return true
		}
		switch x := rhs.(type) {
		case *ast.SelectorExpr:
			return fields[x.Sel.Name]
		case *ast.CallExpr:
			id, ok := x.Fun.(*ast.Ident)
			return ok && ctors[id.Name]
		}
		return false
	}
	bind := func(lhs []ast.Expr, rhs []ast.Expr) {
		for i, r := range rhs {
			if i >= len(lhs) || !carries(r) {
				continue
			}
			if id, ok := lhs[i].(*ast.Ident); ok {
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
//     of a struct field (h.db) and passing it on is a hand-off wherever it
//     goes — the handle has left its carrier. A *db.DB local or parameter is a
//     hand-off only when it is passed to another package (pkg.Func(...),
//     pkg.Type{...}): threading a parameter on to a function or method of this
//     same package hands it to nobody the row does not already name. Callees
//     in the db package itself are never hand-offs — that is the handle's own
//     package, not an owner.
func DBHandleCalls(f *ast.File, vars, fields map[string]bool, calls, hands map[string]int) {
	pkgs := importedNames(f)
	dbAlias := DBHandleAlias(f)

	// ownPkg reports whether a callee or a composite-literal type names the db
	// package itself. Checked on the callee rather than on the argument,
	// because the argument's shape is what differs (h.db is a hand-off
	// wherever it goes, a local only across a package boundary) while the
	// exclusion is the same for both.
	ownPkg := func(e ast.Expr) bool {
		if dbAlias == "" {
			return false
		}
		sel, ok := e.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		id, ok := sel.X.(*ast.Ident)
		return ok && id.Name == dbAlias
	}

	handed := func(arg ast.Expr, crossPkg bool) bool {
		switch a := arg.(type) {
		case *ast.SelectorExpr:
			return fields[a.Sel.Name]
		case *ast.Ident:
			return crossPkg && vars[a.Name]
		}
		return false
	}

	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok && calls != nil {
				switch recv := sel.X.(type) {
				case *ast.Ident:
					if vars[recv.Name] {
						calls[sel.Sel.Name]++
					}
				case *ast.SelectorExpr:
					if fields[recv.Sel.Name] {
						calls[sel.Sel.Name]++
					}
				}
			}
			if hands == nil || ownPkg(x.Fun) {
				return true
			}
			name, crossPkg := calleeName(x.Fun, pkgs)
			for _, arg := range x.Args {
				if handed(arg, crossPkg) {
					hands[name]++
				}
			}
		case *ast.CompositeLit:
			if hands == nil || ownPkg(x.Type) {
				return true
			}
			name, crossPkg := qualifiedName(x.Type, pkgs)
			for _, elt := range x.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok {
					continue
				}
				if handed(kv.Value, crossPkg) {
					hands[name]++
				}
			}
		}
		return true
	})
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
