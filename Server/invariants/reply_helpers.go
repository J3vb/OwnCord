package invariants

import (
	"go/ast"
	"go/token"
	"slices"
)

// replyHelpersID is the rule's stable id.
const replyHelpersID = "reply-helpers"

// replyHelperSites are the functions that may build an errorResponse or a
// json.Decoder by hand: the shared helpers every handler goes through.
var replyHelperSites = map[string]map[string]bool{
	"api/middleware.go": {"writeErr": true},
	"admin/helpers.go":  {"writeErr": true},
	"api/decode.go":     {"decodeJSON": true, "decodeOptionalJSON": true, "decodeStrictJSON": true},
	"admin/decode.go":   {"decodeJSON": true, "decodeOptionalJSON": true, "decodeStrictJSON": true},
}

// pathIDSites are the functions that may parse a chi URL parameter into a
// number: the one admin and api helper each, which refuse an id below 1.
var pathIDSites = map[string]map[string]bool{
	"admin/helpers.go": {"pathInt64": true},
	"api/path_id.go":   {"pathID": true},
}

// replyHelpers enforces MX-7: a REST handler answers an error through
// writeErr and reads a JSON body through decodeJSON (or its optional and
// strict forms), so the same bad input gets the same code and message on
// every route and a body past its cap answers 413. An errorResponse literal
// or a json.NewDecoder call outside the helpers is a violation. It also
// enforces MX-10: a strconv.ParseInt, ParseUint or Atoi of a chi.URLParam
// (directly, or through a local variable assigned from one) is a violation
// outside pathInt64 and pathID, which refuse an id of 0 or below, so a route
// cannot take an id the others reject.
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
		out := make([]Violation, 0, len(literals)+len(decoders))
		for _, pos := range literals {
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg:  "errorResponse built by hand: answer with writeErr(w, status, code, msg) so every error reply has one shape.",
			})
		}
		for _, pos := range decoders {
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "json.NewDecoder outside the shared decoder: read a request body with decodeJSON " +
					"(decodeOptionalJSON when it may be empty, decodeStrictJSON to refuse unknown fields), " +
					"which answers a bad or over-size body the same way on every route.",
			})
		}
		out = append(out, rawPathIDs(f, fset, rel)...)
		return out
	},
}

// rawPathIDs reports every strconv.ParseInt, ParseUint or Atoi in f whose
// argument is a chi.URLParam call, or a local variable assigned from one in
// the same function, outside the file's path-id helper. It is a guard, not a
// proof: a wrapped argument (strings.TrimSpace(chi.URLParam(...))),
// chi.RouteContext(r).URLParam, r.PathValue and package-level func literals
// are not followed.
func rawPathIDs(f *ast.File, fset *token.FileSet, rel string) []Violation {
	chiNames := chiImportNames(f)
	strconvNames, _ := importNames(f, "strconv")
	if len(chiNames) == 0 || len(strconvNames) == 0 {
		return nil
	}
	var out []Violation
	for _, d := range f.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok || fd.Body == nil || pathIDSites[rel][enclosingSymbol(f, fd.Pos())] {
			continue
		}
		for _, pos := range rawParseSites(fd.Body, chiNames, strconvNames, urlParamLocals(fd.Body, chiNames)) {
			out = append(out, Violation{
				Rule: replyHelpersID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "a URL parameter parsed by hand: read a path id with pathInt64 (admin) or pathID / parseIDParam (api), " +
					"which refuse 0 and negative ids so every route takes the same ids.",
			})
		}
	}
	return out
}

// isPkgCall reports whether e is a call of pkg.fn for a pkg in pkgs and an fn
// in fns.
func isPkgCall(e ast.Expr, pkgs map[string]bool, fns ...string) bool {
	call, ok := e.(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkgs[pkg.Name] && slices.Contains(fns, sel.Sel.Name)
}

// urlParamLocals returns the names of the variables body assigns from a
// chi.URLParam call.
func urlParamLocals(body *ast.BlockStmt, chiNames map[string]bool) map[string]bool {
	fromParam := map[string]bool{}
	ast.Inspect(body, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.AssignStmt:
			if len(n.Lhs) != len(n.Rhs) {
				return true
			}
			for i, rhs := range n.Rhs {
				if id, ok := n.Lhs[i].(*ast.Ident); ok && isPkgCall(rhs, chiNames, "URLParam") {
					fromParam[id.Name] = true
				}
			}
		case *ast.ValueSpec:
			if len(n.Names) != len(n.Values) {
				return true
			}
			for i, v := range n.Values {
				if isPkgCall(v, chiNames, "URLParam") {
					fromParam[n.Names[i].Name] = true
				}
			}
		}
		return true
	})
	return fromParam
}

// rawParseSites returns the strconv number parses in body whose argument is a
// chi.URLParam call or one of the fromParam locals.
func rawParseSites(body *ast.BlockStmt, chiNames, strconvNames, fromParam map[string]bool) []token.Pos {
	var sites []token.Pos
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || len(call.Args) == 0 || !isPkgCall(call, strconvNames, "ParseInt", "ParseUint", "Atoi") {
			return true
		}
		arg := call.Args[0]
		if id, ok := arg.(*ast.Ident); isPkgCall(arg, chiNames, "URLParam") || (ok && fromParam[id.Name]) {
			sites = append(sites, call.Pos())
		}
		return true
	})
	return sites
}

// chiImportNames returns the identifiers bound to go-chi/chi/v5 in f. The
// package is named chi although its path ends in v5, so the default name
// importNames derives from the path would be wrong.
func chiImportNames(f *ast.File) map[string]bool {
	names := map[string]bool{}
	for _, imp := range f.Imports {
		if imp.Path.Value != `"github.com/go-chi/chi/v5"` {
			continue
		}
		switch {
		case imp.Name == nil:
			names["chi"] = true
		case imp.Name.Name != "_" && imp.Name.Name != ".":
			names[imp.Name.Name] = true
		}
	}
	return names
}
