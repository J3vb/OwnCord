package invariants

import (
	"go/ast"
	"go/token"
)

// syncutilLocks forbids raw sync.Mutex and sync.RWMutex in the packages whose
// lock order the -tags deadlock CI pass exists to observe.
//
// syncutil.Mutex is a build-tag alias: sync.Mutex in production,
// deadlock.Mutex under -tags deadlock. A lock declared as sync.Mutex is
// therefore invisible to that pass. Server/CLAUDE.md states the rule directly:
// "syncutil exists so lock usage is uniform and detectable; do not hand-roll
// around it."
var syncutilLocks = Rule{
	ID:    "syncutil-locks",
	Scope: []string{"ws", "service"},
	Check: checkSyncutilLocks,
}

func checkSyncutilLocks(f *ast.File, fset *token.FileSet, rel string) []Violation {
	var out []Violation

	ast.Inspect(f, func(n ast.Node) bool {
		var typ ast.Expr
		switch node := n.(type) {
		case *ast.Field: // struct fields, including embedded ones
			typ = node.Type
		case *ast.ValueSpec: // var declarations
			typ = node.Type
		default:
			return true
		}
		if typ == nil {
			return true
		}
		name, ok := rawSyncLock(typ)
		if !ok {
			return true
		}
		out = append(out, Violation{
			Rule: "syncutil-locks",
			File: rel,
			Line: fset.Position(typ.Pos()).Line,
			Msg: "raw sync." + name + " is invisible to the -tags deadlock CI pass; " +
				"declare it as syncutil." + name + " (github.com/owncord/server/syncutil), " +
				"or add //invariant:allow syncutil-locks — <reason>",
		})
		return true
	})

	return out
}

// rawSyncLock reports whether e names sync.Mutex or sync.RWMutex, optionally
// through a pointer, and returns the bare type name. sync.Once, sync.WaitGroup
// and sync.Map are deliberately not matched: they carry no lock order.
func rawSyncLock(e ast.Expr) (string, bool) {
	if star, ok := e.(*ast.StarExpr); ok {
		e = star.X
	}
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	pkg, ok := sel.X.(*ast.Ident)
	if !ok || pkg.Name != "sync" {
		return "", false
	}
	switch sel.Sel.Name {
	case "Mutex", "RWMutex":
		return sel.Sel.Name, true
	}
	return "", false
}
