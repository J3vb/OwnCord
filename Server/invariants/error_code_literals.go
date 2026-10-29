package invariants

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path"
	"sort"
	"strconv"
	"strings"
)

// errorCodeLiteralsID is the rule's stable id.
const errorCodeLiteralsID = "error-code-literals"

// errorCodeSources are the files genprotocol writes from the error_codes of
// protocol/schema.json: the REST codes (httperr.Code) and the WebSocket codes
// (ws.ErrCode*). The rule reads the code set from them, so a code added to the
// schema is covered without touching this file.
var errorCodeSources = []string{"httperr/codes.go", "ws/message_types.go"}

// errorCodeScope is where error replies are built.
var errorCodeScope = []string{"api", "admin", "plugin", "httperr", "ws"}

// errorCodeLiterals enforces MX-16: an error code is spelt as its generated
// constant (httperr.CodeBadRequest, ws.ErrCodeForbidden), never as a string
// literal. A literal still compiles where an httperr.Code goes, so only this
// rule stops a misspelt or unlisted code from reaching a client whose branch
// for it then never runs. Any string literal in scope equal to a known code is
// a violation, wherever it sits: a writeErr argument, a struct field, an
// assignment to a code variable.
var errorCodeLiterals = Rule{
	ID:    errorCodeLiteralsID,
	Scope: errorCodeScope,
	Tree: func(fsys fs.FS) []Violation {
		codes := generatedErrorCodes(fsys)
		if len(codes) == 0 {
			return []Violation{{
				Rule: errorCodeLiteralsID,
				File: errorCodeSources[0],
				Msg:  "no error codes found in the generated files: run `make protocol-generate` in Server/.",
			}}
		}
		generated := map[string]bool{}
		for _, s := range errorCodeSources {
			generated[s] = true
		}
		var out []Violation
		for _, dir := range errorCodeScope {
			_ = fs.WalkDir(fsys, dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					return nil
				}
				if d.IsDir() {
					if p != dir && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
						return fs.SkipDir
					}
					return nil
				}
				if !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") || generated[p] {
					return nil
				}
				out = append(out, errorCodeLiteralsIn(fsys, path.Clean(p), codes)...)
				return nil
			})
		}
		sort.SliceStable(out, func(i, j int) bool {
			if out[i].File != out[j].File {
				return out[i].File < out[j].File
			}
			return out[i].Line < out[j].Line
		})
		return out
	},
}

// generatedErrorCodes maps each wire code to its constant, qualified the way
// a caller outside its package spells it.
func generatedErrorCodes(fsys fs.FS) map[string]string {
	codes := map[string]string{}
	for _, name := range errorCodeSources {
		src, err := fs.ReadFile(fsys, name)
		if err != nil {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), name, src, 0)
		if err != nil {
			continue
		}
		pkg := f.Name.Name
		for _, d := range f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok || len(vs.Names) != 1 || len(vs.Values) != 1 {
					continue
				}
				cname := vs.Names[0].Name
				isREST := pkg == "httperr" && strings.HasPrefix(cname, "Code")
				if !isREST && !strings.HasPrefix(cname, "ErrCode") {
					continue
				}
				lit, ok := vs.Values[0].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					continue
				}
				wire, err := strconv.Unquote(lit.Value)
				if err != nil {
					continue
				}
				// A wire value both lists share (FORBIDDEN, NOT_FOUND) names
				// the REST constant first; the message names both.
				if prev, seen := codes[wire]; seen {
					codes[wire] = prev + " or " + pkg + "." + cname
					continue
				}
				codes[wire] = pkg + "." + cname
			}
		}
	}
	return codes
}

func errorCodeLiteralsIn(fsys fs.FS, rel string, codes map[string]string) []Violation {
	src, err := fs.ReadFile(fsys, rel)
	if err != nil {
		return nil
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, rel, src, 0)
	if err != nil {
		return nil
	}
	var out []Violation
	ast.Inspect(f, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.ImportSpec:
			return false
		case *ast.BasicLit:
			if n.Kind != token.STRING {
				return true
			}
			v, err := strconv.Unquote(n.Value)
			if err != nil {
				return true
			}
			if c, ok := codes[v]; ok {
				out = append(out, Violation{
					Rule: errorCodeLiteralsID,
					File: rel,
					Line: fset.Position(n.Pos()).Line,
					Msg: "error code " + strconv.Quote(v) + " spelt as a literal: use " + c +
						". A new code goes in error_codes of protocol/schema.json, then `make protocol-generate`.",
				})
			}
		}
		return true
	})
	return out
}
