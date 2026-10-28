package invariants

import (
	"go/ast"
	"go/token"
)

// wsPayloadIDsID is the rule's stable id.
const wsPayloadIDsID = "ws-payload-ids"

// wsPayloadIDsHelper is the one function that may read a json.Number as an
// int64 id: positiveID in ws/ids.go (MX-12).
const (
	wsPayloadIDsFile   = "ws/ids.go"
	wsPayloadIDsSymbol = "positiveID"
)

// wsPayloadIntFields are the non-id integer fields read with Int64 on
// purpose, by file and json.Number field name. duration_hours is a bounded
// count of hours that may legitimately be 0, so it is not a positive id.
var wsPayloadIntFields = map[string]map[string]bool{
	"ws/command_poll.go": {"DurationHours": true},
}

// wsPayloadIDs enforces MX-12: a WebSocket payload id is read with
// positiveID, so every command refuses an absent, fractional, zero or negative
// id with the same "<field> must be a positive integer" error. A zero-argument
// .Int64() call anywhere else in ws is a hand-rolled id read that can drift
// (it once accepted 0 and negatives on five commands).
var wsPayloadIDs = Rule{
	ID:    wsPayloadIDsID,
	Scope: []string{"ws"},
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		var out []Violation
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) != 0 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Int64" {
				return true
			}
			if rel == wsPayloadIDsFile && enclosingSymbol(f, call.Pos()) == wsPayloadIDsSymbol {
				return true
			}
			if recv, ok := sel.X.(*ast.SelectorExpr); ok && wsPayloadIntFields[rel][recv.Sel.Name] {
				return true
			}
			out = append(out, Violation{
				Rule: wsPayloadIDsID,
				File: rel,
				Line: fset.Position(call.Pos()).Line,
				Msg: "json.Number.Int64() outside positiveID: read a payload id with positiveID(n, field) " +
					"(ws/ids.go) so a zero, negative, fractional or missing id is refused the same way on every command.",
			})
			return true
		})
		return out
	},
}
