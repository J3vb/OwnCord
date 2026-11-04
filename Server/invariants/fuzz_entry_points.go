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

// fuzzEntryPointsID is the rule's stable id.
const fuzzEntryPointsID = "fuzz-entry-points"

// fuzzSinkPackages maps import paths to the calls that turn bytes into
// structure: JSON and XML decoders, image decoders, archive and compression
// readers, the HTML parser, and multipart readers. A function that makes one
// of these calls is where outside data could enter the server, so the rule
// asks it to be accounted for in the inventory below.
var fuzzSinkPackages = map[string]map[string]bool{
	"encoding/json":           {"Unmarshal": true, "NewDecoder": true},
	"encoding/xml":            {"Unmarshal": true, "NewDecoder": true},
	"image":                   {"Decode": true, "DecodeConfig": true},
	"image/png":               {"Decode": true, "DecodeConfig": true},
	"image/jpeg":              {"Decode": true, "DecodeConfig": true},
	"image/gif":               {"Decode": true, "DecodeConfig": true, "DecodeAll": true},
	"golang.org/x/image/webp": {"Decode": true, "DecodeConfig": true},
	"archive/zip":             {"NewReader": true, "OpenReader": true},
	"archive/tar":             {"NewReader": true},
	"compress/gzip":           {"NewReader": true},
	"compress/flate":          {"NewReader": true},
	"golang.org/x/net/html":   {"Parse": true, "ParseFragment": true, "NewTokenizer": true},
	"mime/multipart":          {"NewReader": true},
}

// fuzzSinkMethods are request methods that parse a multipart body. They are
// matched on any receiver, since the receiver's type is not visible to a
// syntactic rule.
var fuzzSinkMethods = map[string]bool{"ParseMultipartForm": true, "MultipartReader": true, "FormFile": true}

// fuzzSkipped reports whether rel is outside the rule: test files, generated
// files (checked by the caller), CI harnesses and tools under cmd/, and the
// example plugins, none of which ship in a server release.
func fuzzSkipped(rel string) bool {
	return strings.HasPrefix(rel, "cmd/") || strings.Contains(rel, "/examples/")
}

// fuzzSymbol is enclosingSymbol, except that code inside a package-level
// variable (a table of decoder closures) is named after the variable rather
// than lumped together as file scope.
func fuzzSymbol(f *ast.File, pos token.Pos) string {
	if sym := enclosingSymbol(f, pos); sym != fileScopeSymbol {
		return sym
	}
	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || pos < gd.Pos() || pos >= gd.End() {
			continue
		}
		for _, spec := range gd.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if ok && pos >= vs.Pos() && pos < vs.End() && len(vs.Names) > 0 {
				return vs.Names[0].Name
			}
		}
	}
	return fileScopeSymbol
}

// fuzzKey names a function by package directory and symbol, so a function
// moved to another file in the same package keeps its row.
func fuzzKey(rel, symbol string) string {
	dir := path.Dir(rel)
	return dir + "." + symbol
}

type fuzzSink struct {
	key  string
	line int
	what string
}

// fuzzSinks lists every decoding call in f, keyed by its enclosing function.
func fuzzSinks(f *ast.File, fset *token.FileSet, rel string) []fuzzSink {
	if ast.IsGenerated(f) {
		return nil
	}
	var out []fuzzSink
	add := func(n ast.Node, what string) {
		out = append(out, fuzzSink{key: fuzzKey(rel, fuzzSymbol(f, n.Pos())), line: fset.Position(n.Pos()).Line, what: what})
	}
	for importPath, calls := range fuzzSinkPackages {
		names, dots := importNames(f, importPath)
		for _, d := range dots {
			add(d, "dot-import of "+importPath)
		}
		if len(names) == 0 {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok {
				if pkg, sym, ok := selector(call.Fun); ok && names[pkg] && calls[sym] {
					add(call, pkg+"."+sym+"()")
				}
			}
			return true
		})
	}
	ast.Inspect(f, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok && fuzzSinkMethods[sel.Sel.Name] {
			add(call, "."+sel.Sel.Name+"()")
		}
		return true
	})
	return out
}

// fuzzRowFor reports which table accounts for key, if any.
func fuzzRowFor(key string) (table string, ok bool) {
	if _, ok := FuzzEntryPoints[key]; ok {
		return "FuzzEntryPoints", true
	}
	if _, ok := FuzzGaps[key]; ok {
		return "FuzzGaps", true
	}
	if _, ok := FuzzTrustedDecodes[key]; ok {
		return "FuzzTrustedDecodes", true
	}
	return "", false
}

var fuzzEntryPoints = Rule{
	ID: fuzzEntryPointsID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		if fuzzSkipped(rel) {
			return nil
		}
		var out []Violation
		for _, s := range fuzzSinks(f, fset, rel) {
			if _, ok := fuzzRowFor(s.key); ok {
				continue
			}
			out = append(out, Violation{
				Rule: fuzzEntryPointsID,
				File: rel,
				Line: s.line,
				Msg: s.what + " in " + s.key + " decodes bytes, and that function is not in the fuzz inventory " +
					"(invariants/fuzz_entry_table.go). Data from clients, uploads, fetched pages and imports must " +
					"have a fuzz target: add the function to FuzzEntryPoints with the target that drives it, or to " +
					"FuzzTrustedDecodes when the bytes are ones this server wrote itself. FuzzGaps only shrinks.",
			})
		}
		return out
	},
	Tree: fuzzTree,
}

// fuzzIndex is what the tree check needs to know about the tree: every
// function and package-level variable, every decoding function, and every
// fuzz target, all as fuzzKey keys.
type fuzzIndex struct {
	funcs, sinks, targets map[string]bool
}

// fuzzTree checks the inventory against the tree: every row names a function
// that still exists, a decoding row still decodes, every named target exists,
// no function sits in two tables, and the gap count matches its ceiling.
func fuzzTree(fsys fs.FS) []Violation {
	idx := fuzzScan(fsys)
	var out []Violation
	bad := func(table, msg string) {
		out = append(out, Violation{Rule: fuzzEntryPointsID, File: "invariants/fuzz_entry_table.go", Msg: table + ": " + msg})
	}
	seen := map[string]string{}
	check := func(table string, keys []string, needSink bool) {
		for _, k := range keys {
			if prev, dup := seen[k]; dup {
				bad(table, k+" is also in "+prev+"; a function belongs in one table")
			}
			seen[k] = table
			switch {
			case !idx.funcs[k]:
				bad(table, k+" names no function in the tree; drop or rename the row")
			case needSink && !idx.sinks[k]:
				bad(table, k+" no longer decodes anything; drop the row")
			}
		}
	}
	check("FuzzEntryPoints", sortedKeys(FuzzEntryPoints), false)
	check("FuzzGaps", sortedKeys(FuzzGaps), false)
	check("FuzzTrustedDecodes", sortedKeys(FuzzTrustedDecodes), true)
	fuzzCheckTargets(idx, bad)
	fuzzCheckGaps(idx, bad)
	return out
}

func fuzzCheckTargets(idx fuzzIndex, bad func(table, msg string)) {
	for _, k := range sortedKeys(FuzzEntryPoints) {
		e := FuzzEntryPoints[k]
		if len(e.Targets) == 0 {
			bad("FuzzEntryPoints", k+" names no fuzz target; a function without one belongs in FuzzGaps")
		}
		for _, t := range e.Targets {
			if !idx.targets[t] {
				bad("FuzzEntryPoints", k+" names fuzz target "+t+", which does not exist")
			}
		}
	}
}

func fuzzCheckGaps(idx fuzzIndex, bad func(table, msg string)) {
	for _, k := range sortedKeys(FuzzGaps) {
		if !idx.sinks[k] && !FuzzGaps[k].Manual {
			bad("FuzzGaps", k+" no longer decodes anything; drop the row or mark it Manual")
		}
	}
	switch n := len(FuzzGaps); {
	case n > fuzzGapCeiling:
		bad("FuzzGaps", "has "+strconv.Itoa(n)+" rows, over the ceiling of "+strconv.Itoa(fuzzGapCeiling)+
			"; the table only shrinks, so give the new entry point a fuzz target")
	case n < fuzzGapCeiling:
		bad("FuzzGaps", "has "+strconv.Itoa(n)+" rows; lower fuzzGapCeiling to "+strconv.Itoa(n)+" so the closed gap stays closed")
	}
}

// fuzzScan indexes every .go file under fsys. A file that does not parse is
// skipped here; the per-file walk already reports it.
func fuzzScan(fsys fs.FS) fuzzIndex {
	idx := fuzzIndex{funcs: map[string]bool{}, sinks: map[string]bool{}, targets: map[string]bool{}}
	fset := token.NewFileSet()
	_ = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != "." && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		src, err := fs.ReadFile(fsys, p)
		if err != nil {
			return err
		}
		if f, perr := parser.ParseFile(fset, p, src, parser.ParseComments); perr == nil {
			idx.add(f, fset, p)
		}
		return nil
	})
	return idx
}

func (idx fuzzIndex) add(f *ast.File, fset *token.FileSet, p string) {
	if strings.HasSuffix(p, "_test.go") {
		for _, decl := range f.Decls {
			if fd, ok := decl.(*ast.FuncDecl); ok && fd.Recv == nil && strings.HasPrefix(fd.Name.Name, "Fuzz") {
				idx.targets[fuzzKey(p, fd.Name.Name)] = true
			}
		}
		return
	}
	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			if d.Tok != token.VAR {
				continue
			}
			for _, spec := range d.Specs {
				for _, n := range spec.(*ast.ValueSpec).Names {
					idx.funcs[fuzzKey(p, n.Name)] = true
				}
			}
		case *ast.FuncDecl:
			if d.Body != nil {
				idx.funcs[fuzzKey(p, enclosingSymbol(f, d.Body.Pos()))] = true
			}
		}
	}
	for _, s := range fuzzSinks(f, fset, p) {
		idx.sinks[s.key] = true
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
