package invariants

import (
	"go/ast"
	"go/token"
	"path"
	"strconv"
)

// dbTimeLayoutsID is the rule's stable id.
const dbTimeLayoutsID = "db-time-layouts"

// dbTimeLayoutHomes may spell a stored timestamp layout out: dbtime, which
// defines the names, and this package, which has to match the text.
var dbTimeLayoutHomes = map[string]bool{"dbtime": true, "invariants": true}

// dbTimeLayoutValues are the two layouts the database stores timestamps in.
var dbTimeLayoutValues = map[string]bool{
	"2006-01-02 15:04:05":  true,
	"2006-01-02T15:04:05Z": true,
}

// dbTimeLayouts enforces the timestamp-layout rule: a stored timestamp layout is named through
// dbtime.SQLiteLayout or dbtime.ISOLayout, and two stored forms are read
// through dbtime.Parse. SQLite compares TEXT dates byte by byte and 'T' sorts
// after ' ', so a value written in one layout and compared with the other is
// wrong until midnight UTC; one name per layout keeps the choice visible at
// every writer. A literal equal to either layout outside dbtime, or the
// stdlib's time.DateTime (the same text as SQLiteLayout), is a violation.
var dbTimeLayouts = Rule{
	ID: dbTimeLayoutsID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		if dbTimeLayoutHomes[path.Dir(rel)] {
			return nil
		}
		timeNames, timeDots := importNames(f, "time")
		selectors := make(map[*ast.Ident]bool)
		var out []Violation
		report := func(pos token.Pos) {
			out = append(out, Violation{
				Rule: dbTimeLayoutsID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "stored timestamp layout spelled out by hand: use dbtime.SQLiteLayout (datetime('now') text) " +
					"or dbtime.ISOLayout (strftime '%Y-%m-%dT%H:%M:%SZ' text), and dbtime.Parse to read either.",
			})
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.BasicLit:
				if n.Kind != token.STRING {
					return true
				}
				if s, err := strconv.Unquote(n.Value); err == nil && dbTimeLayoutValues[s] {
					report(n.Pos())
				}
			case *ast.Ident:
				// import . "time" lets DateTime be spelled bare.
				if len(timeDots) > 0 && n.Name == "DateTime" && !selectors[n] {
					report(n.Pos())
				}
			case *ast.SelectorExpr:
				if pkg, ok := n.X.(*ast.Ident); ok && timeNames[pkg.Name] && n.Sel.Name == "DateTime" {
					report(n.Pos())
				}
				// Sel is an Ident too: row.DateTime is not the layout.
				selectors[n.Sel] = true
			}
			return true
		})
		return out
	},
}
