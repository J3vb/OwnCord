package invariants

import (
	"fmt"
	"go/ast"
	"go/token"
	"strings"
)

// fileSizesID is the rule's stable id.
const fileSizesID = "file-sizes"

// DefaultFileLimit is the ceiling every non-test Go file under Server/ is held
// to. A new file is capped the moment it is created.
//
// The rule used to cap exactly three files — the ws coordination hotspots
// someone had already shrunk — and nothing else, so 35 files sat over the same
// 500 lines unflagged, the largest of them six times it. An allowlist that
// names only the files that were hot when it was written drifts away from
// where the risk lives; a default with declared exemptions cannot. Those 35
// were then split by concern until none needed an exemption, so the table
// below holds only ceilings tighter than the default.
const DefaultFileLimit = 500

// FileSizeOverride classes. A row's class says why its ceiling differs from
// the default, so a whole class can be judged at once rather than one file at
// a time. Every class is at or under the default: a file over 500 lines is
// split, never exempted.
const (
	// classB3ExitTarget: an exit target, tighter than the default. The
	// architecture plan set these for the ws coordination hotspots
	// (docs/archive/plans/b3-server-architecture-guardrails-2026-08-29.md, exit criteria)
	// and recorded them met at 361/424/183. hub_broadcast.go and serve.go are
	// no longer listed — the default covers them now; only hub.go's 400 still
	// bites.
	classB3ExitTarget = "b3-exit-target"

	// classRegistrationPoint: a wiring file every feature used to edit, now
	// a short list features register into. Held tighter than the default so
	// a feature's routes go in its own file, not back into the wiring. Only
	// goes down.
	classRegistrationPoint = "registration-point"
)

// FileSizeOverride is one declared ceiling that replaces DefaultFileLimit.
type FileSizeOverride struct {
	Ceiling int    // lines: the file fails above this
	Class   string // one of the class constants above
	Note    string // what the file is, so the row can be judged
}

// FileSizeOverrides is the table of tighter ceilings, keyed by path relative
// to the Server tree.
//
// cmd/ is deliberately absent as a class and skipped in the rule instead: it
// holds entry points and one-shot tooling, where a long main is a shape rather
// than a smell. The skip lives here rather than in the shared skipDirs because
// the other rules cover cmd/ legitimately.
var FileSizeOverrides = map[string]FileSizeOverride{
	"ws/hub.go": {
		Ceiling: 400,
		Class:   classB3ExitTarget,
		Note:    "hub: client registry, broadcast fan-out, replay",
	},
	"api/router.go": {
		Ceiling: 300,
		Class:   classRegistrationPoint,
		Note:    "middleware chain and NewRouter; feature routes live in route_groups.go and their own files",
	},
}

var fileSizes = Rule{
	ID: fileSizesID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		// Rule-local, not skipDirs: the other rules cover cmd/ legitimately.
		if strings.HasPrefix(rel, "cmd/") {
			return nil
		}
		limit := DefaultFileLimit
		why := fmt.Sprintf("the %d-line default (invariants.DefaultFileLimit)", DefaultFileLimit)
		split := "Split the new code into a sibling file."
		if o, ok := FileSizeOverrides[rel]; ok {
			limit = o.Ceiling
			why = fmt.Sprintf("its declared %d-line ceiling (invariants.FileSizeOverrides, class %q)",
				o.Ceiling, o.Class)
			split = "Split the new code into a sibling file rather than raising the ceiling."
		}
		lines := fset.File(f.Pos()).LineCount()
		if lines <= limit {
			return nil
		}
		return []Violation{{
			Rule: fileSizesID,
			File: rel,
			Line: lines,
			Msg: fmt.Sprintf("%s is %d lines, over %s. %s",
				rel, lines, why, split),
		}}
	},
}
