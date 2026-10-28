package invariants

import (
	"go/ast"
	"go/token"
	"strconv"
)

// replyHelpersID is the rule's stable id.
const replyHelpersID = "reply-helpers"

// replyHelperSites are the functions that may build an errorResponse or a
// json.Decoder by hand: the shared helpers every handler goes through.
var replyHelperSites = map[string]map[string]bool{
	"api/middleware.go": {"writeErr": true},
	"admin/helpers.go":  {"writeErr": true},
	"api/decode.go":     {"decodeJSON": true, "decodeOptionalJSON": true, "decodeStrictJSON": true},
}

// DecodeAllow counts the hand-written json.NewDecoder calls each file not yet
// moved to the shared decoder may still hold (MX-7). It is a ratchet: a file
// not listed may hold none, a listed file over its count fails, and a listed
// file under it fails too, so the count is lowered as each site moves and the
// row is deleted at zero.
var DecodeAllow = map[string]int{
	"admin/handlers_access.go":           1,
	"admin/handlers_afk.go":              1,
	"admin/handlers_categories.go":       3,
	"admin/handlers_category_perms.go":   1,
	"admin/handlers_channel_perms.go":    1,
	"admin/handlers_channels.go":         2,
	"admin/handlers_config_overrides.go": 1,
	"admin/handlers_forum.go":            1,
	"admin/handlers_recovery.go":         1,
	"admin/handlers_retention.go":        2,
	"admin/handlers_roles.go":            3,
	"admin/handlers_settings.go":         1,
	"admin/handlers_tokens.go":           1,
	"admin/handlers_users.go":            1,
	"admin/loglevel.go":                  1,
	"admin/setup_handler.go":             1,
	"admin/support_bundle.go":            1,
}

// replyHelpers enforces MX-7: a REST handler answers an error through
// writeErr and reads a JSON body through decodeJSON (or its optional and
// strict forms), so the same bad input gets the same code and message on
// every route and a body past its cap answers 413. An errorResponse literal
// outside writeErr is always a violation; a json.NewDecoder call outside the
// helpers is one unless DecodeAllow still counts it.
var replyHelpers = Rule{
	ID:    replyHelpersID,
	Scope: []string{"api", "admin"},
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		helpers := replyHelperSites[rel]
		jsonNames, _ := importNames(f, "encoding/json")
		var literals, decoders []token.Pos
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CompositeLit:
				if id, ok := n.Type.(*ast.Ident); ok && id.Name == "errorResponse" && !helpers[enclosingSymbol(f, n.Pos())] {
					literals = append(literals, n.Pos())
				}
			case *ast.CallExpr:
				sel, ok := n.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "NewDecoder" {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); ok && jsonNames[pkg.Name] && !helpers[enclosingSymbol(f, n.Pos())] {
					decoders = append(decoders, n.Pos())
				}
			}
			return true
		})
		var out []Violation
		for _, pos := range literals {
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg:  "errorResponse built by hand: answer with writeErr(w, status, code, msg) so every error reply has one shape.",
			})
		}
		allowed := DecodeAllow[rel]
		for i, pos := range decoders {
			if i < allowed {
				continue
			}
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "json.NewDecoder outside the shared decoder: read a request body with decodeJSON " +
					"(decodeOptionalJSON when it may be empty, decodeStrictJSON to refuse unknown fields), " +
					"which answers 400 INVALID_INPUT or 413 PAYLOAD_TOO_LARGE the same way on every route.",
			})
		}
		if _, listed := DecodeAllow[rel]; listed && len(decoders) < allowed {
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: 1,
				Msg: "invariants.DecodeAllow lists " + rel + " with " + strconv.Itoa(allowed) +
					" decoder(s) but the file has " + strconv.Itoa(len(decoders)) +
					": the ratchet only goes down. Lower the count, or delete the row at zero.",
			})
		}
		return out
	},
}
