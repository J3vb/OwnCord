package invariants

import (
	"fmt"
	"go/ast"
	"go/token"
)

// fileSizesID is the rule's stable id.
const fileSizesID = "file-sizes"

// FileSizeLimits holds the B3-5 exit targets for the ws coordination
// hotspots (docs/plans/b3-server-architecture-guardrails-2026-08-29.md,
// "B3-5 exit"): hub_broadcast.go and serve.go under 500 lines, hub.go under
// 400. The plan recorded these as met at 361/424/183, then drift — OC-0400 —
// pushed hub.go back over 400 with no gate to catch it. A file over its
// limit fails CI; split the new code into a sibling file (as hub_stats.go
// did for hub.go) rather than raising the number here.
var FileSizeLimits = map[string]int{
	"ws/hub.go":           400,
	"ws/hub_broadcast.go": 500,
	"ws/serve.go":         500,
}

var fileSizes = Rule{
	ID: fileSizesID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		limit, ok := FileSizeLimits[rel]
		if !ok {
			return nil
		}
		lines := fset.File(f.Pos()).LineCount()
		if lines <= limit {
			return nil
		}
		return []Violation{{
			Rule: fileSizesID,
			File: rel,
			Line: lines,
			Msg: fmt.Sprintf("%s is %d lines, over its %d-line B3-5 exit target "+
				"(invariants.FileSizeLimits, docs/plans/b3-server-architecture-guardrails-2026-08-29.md). "+
				"Split the new code into a sibling file instead of raising the limit.", rel, lines, limit),
		}}
	},
}
