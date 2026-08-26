package invariants

import (
	"go/ast"
	"go/token"
	"strconv"
)

// syncutilLocksID is the rule's stable id. It is a const, not a field read
// off syncutilLocks, because the Rule var's own initializer (Check:
// checkSyncutilLocks) would otherwise form an initialization cycle with the
// function that emits it.
const syncutilLocksID = "syncutil-locks"

// syncutilLocks forbids raw sync.Mutex and sync.RWMutex in the packages whose
// lock order the -tags deadlock CI pass exists to observe.
//
// syncutil.Mutex is a build-tag alias: sync.Mutex in production,
// deadlock.Mutex under -tags deadlock. A lock declared as sync.Mutex is
// therefore invisible to that pass. Server/CLAUDE.md states the rule directly:
// "syncutil exists so lock usage is uniform and detectable; do not hand-roll
// around it."
var syncutilLocks = Rule{
	ID:    syncutilLocksID,
	Scope: []string{"ws", "service"},
	Check: checkSyncutilLocks,
}

// checkSyncutilLocks flags any sync.Mutex/sync.RWMutex selector, wherever it
// syntactically appears: struct field, embedded field, var spec (typed or
// inferred from a composite literal), short assignment, type alias, or
// composite element/value type ([]sync.Mutex, map[K]sync.Mutex). A single
// selector match subsumes all of these, so no per-construct cases are needed.
//
// A dot-import of "sync" is reported separately: it would let a bare Mutex
// evade the selector match entirely.
func checkSyncutilLocks(f *ast.File, fset *token.FileSet, rel string) []Violation {
	var out []Violation

	names, dotImports := syncImportNames(f)

	for _, imp := range dotImports {
		out = append(out, Violation{
			Rule: syncutilLocksID,
			File: rel,
			Line: fset.Position(imp.Pos()).Line,
			Msg:  `dot-import of "sync" defeats syncutil-locks (a bare Mutex/RWMutex can no longer be matched); import sync normally`,
		})
	}

	if len(names) == 0 {
		return out
	}

	ast.Inspect(f, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := sel.X.(*ast.Ident)
		if !ok || !names[pkg.Name] {
			return true
		}
		name := sel.Sel.Name
		if name != "Mutex" && name != "RWMutex" {
			return true
		}
		out = append(out, Violation{
			Rule: syncutilLocksID,
			File: rel,
			Line: fset.Position(sel.Pos()).Line,
			Msg: "raw sync." + name + " is invisible to the -tags deadlock CI pass; " +
				"declare it as syncutil." + name + " (github.com/J3vb/OwnCord/Server/syncutil), " +
				"or add //invariant:allow syncutil-locks — <reason>",
		})
		return true
	})

	return out
}

// syncImportNames returns the local identifiers this file binds to the
// "sync" import path (its name, or an alias), and separately every dot-import
// of "sync" (import . "sync"), which binds no identifier at all.
func syncImportNames(f *ast.File) (names map[string]bool, dotImports []*ast.ImportSpec) {
	names = make(map[string]bool)
	for _, imp := range f.Imports {
		p, err := strconv.Unquote(imp.Path.Value)
		if err != nil || p != "sync" {
			continue
		}
		switch {
		case imp.Name == nil:
			names["sync"] = true
		case imp.Name.Name == "_":
			// Blank import: no identifier is bound, so sync.Mutex cannot be
			// spelled at all.
		case imp.Name.Name == ".":
			dotImports = append(dotImports, imp)
		default:
			names[imp.Name.Name] = true
		}
	}
	return names, dotImports
}
