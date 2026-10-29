package invariants

import (
	"go/ast"
	"go/token"
)

// plainTextRepliesID is the rule's stable id.
const plainTextRepliesID = "plain-text-replies"

// plainTextReplies enforces the reply-helper rule for plain text: no handler answers an error with
// http.Error, which writes text/plain, so a client reading the JSON envelope
// gets no code. api and admin answer through writeErr; every other package
// (the plugin asset server, the LiveKit webhook, the WebSocket upgrade)
// through httperr.Write. A dot-import of net/http is flagged too, since it
// would let an unqualified Error(w, …) through.
var plainTextReplies = Rule{
	ID: plainTextRepliesID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		names, dots := importNames(f, "net/http")
		var sites []token.Pos
		for _, d := range dots {
			sites = append(sites, d.Pos())
		}
		if len(names) > 0 {
			ast.Inspect(f, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok && isPkgCall(call, names, "Error") {
					sites = append(sites, n.Pos())
				}
				return true
			})
		}
		out := make([]Violation, 0, len(sites))
		for _, pos := range sites {
			out = append(out, Violation{
				Rule: plainTextRepliesID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "http.Error answers plain text: answer with writeErr (api, admin) or httperr.Write " +
					"so every error reply is the JSON envelope.",
			})
		}
		return out
	},
}
