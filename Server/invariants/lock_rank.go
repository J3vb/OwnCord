package invariants

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"sort"
	"strconv"
	"strings"
)

// lockRankID is the rule's stable id (a const for the same reason as
// lockInventoryID).
const lockRankID = "lock-rank"

// lockRank holds the rank column of ws/lock_order.go to the code, so the
// written order and the one the deadlock build checks are the same order.
//
// lock-inventory proves every lock has a row. It cannot tell whether the rank
// a row gives is the rank the lock carries: a ranked lock is a
// syncutil.Ranked[R] or RankedRW[R], R is a rank type declared in
// lock_order.go with a Rank method, and the deadlock build panics on an
// acquire out of that order (syncutil/ranked_deadlock.go). This rule fails:
//
//   - a table that is not in rank order (outermost first, unranked rows last);
//   - a rank type whose Rank method does not return an integer literal, or a
//     lock whose R is not a rank type of lock_order.go;
//   - a lock whose R's rank is not the rank of its row;
//   - a lock whose row has a rank but whose type is a plain mutex, which the
//     deadlock build cannot check, and a ranked lock in an unranked row;
//   - a lock whose R is a type parameter (userLockEntry[R].mu) when the ranks
//     the generic type is instantiated with in ws differ from its rows' ranks.
var lockRank = Rule{
	ID:    lockRankID,
	Scope: []string{lockInventoryDir},
	Tree:  checkLockRankTree,
}

func checkLockRankTree(fsys fs.FS) []Violation {
	files, bad := readLockFiles(fsys, lockRankID)
	if bad != nil {
		return bad
	}
	return checkLockRanks(files)
}

// checkLockRanks is the rule over in-memory sources keyed by slash path.
func checkLockRanks(files map[string][]byte) []Violation {
	fset := token.NewFileSet()
	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	var out []Violation
	var decls []lockDecl
	var rows []lockRow
	parsed := make([]*ast.File, 0, len(paths))
	rankOf := make(map[string]int)
	for _, p := range paths {
		f, err := parser.ParseFile(fset, p, files[p], parser.ParseComments)
		if err != nil {
			out = append(out, Violation{Rule: lockRankID, File: p, Msg: "parse: " + err.Error()})
			continue
		}
		parsed = append(parsed, f)
		if p == lockOrderFile {
			rows = lockTableRows(f, fset)
			out = append(out, rankMethods(f, fset, rankOf)...)
		}
		decls = append(decls, lockDecls(f, fset, p)...)
	}
	if rows == nil {
		return out // lock-inventory reports a missing or empty table
	}

	out = append(out, rankTableOrder(rows)...)
	byName := make(map[string][]lockRow)
	for _, r := range rows {
		byName[r.name] = append(byName[r.name], r)
	}
	inst := genericRanks(parsed, rankOf)
	for _, d := range decls {
		rs, ok := byName[d.name]
		if !ok {
			continue // lock-inventory reports the missing row
		}
		if msg := rankMismatch(d, rs, rankOf, inst); msg != "" {
			out = append(out, Violation{Rule: lockRankID, File: d.file, Line: d.line, Msg: msg})
		}
	}
	return out
}

// rankMethods reads `func (T) Rank() int { return N }` from lock_order.go.
func rankMethods(f *ast.File, fset *token.FileSet, rankOf map[string]int) []Violation {
	var out []Violation
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv == nil || len(fn.Recv.List) != 1 || fn.Name.Name != "Rank" {
			continue
		}
		recv, ok := fn.Recv.List[0].Type.(*ast.Ident)
		if !ok {
			continue
		}
		n, ok := literalReturn(fn)
		if !ok {
			out = append(out, Violation{Rule: lockRankID, File: lockOrderFile, Line: fset.Position(fn.Pos()).Line,
				Msg: fmt.Sprintf("%s.Rank must be `return <integer literal>`, so the table can be checked against it", recv.Name)})
			continue
		}
		rankOf[recv.Name] = n
	}
	return out
}

func literalReturn(fn *ast.FuncDecl) (int, bool) {
	if fn.Body == nil || len(fn.Body.List) != 1 {
		return 0, false
	}
	ret, ok := fn.Body.List[0].(*ast.ReturnStmt)
	if !ok || len(ret.Results) != 1 {
		return 0, false
	}
	lit, ok := ret.Results[0].(*ast.BasicLit)
	if !ok || lit.Kind != token.INT {
		return 0, false
	}
	n, err := strconv.Atoi(lit.Value)
	return n, err == nil
}

// rankTableOrder fails a row ranked below the row before it, and a ranked row
// after an unranked one.
func rankTableOrder(rows []lockRow) []Violation {
	var out []Violation
	prev, sawUnranked := 0, false
	for _, r := range rows {
		if r.rank == "-" {
			sawUnranked = true
			continue
		}
		n, _ := strconv.Atoi(r.rank)
		switch {
		case sawUnranked:
			out = append(out, Violation{Rule: lockRankID, File: lockOrderFile, Line: r.line,
				Msg: fmt.Sprintf("row for %s (rank %d) follows an unranked row; unranked rows go last", r.name, n)})
		case n < prev:
			out = append(out, Violation{Rule: lockRankID, File: lockOrderFile, Line: r.line,
				Msg: fmt.Sprintf("row for %s (rank %d) follows a row of rank %d; the table runs outermost first, in rank order", r.name, n, prev)})
		default:
			prev = n
		}
	}
	return out
}

// rankMismatch compares one lock with its rows and says what is wrong, or "".
func rankMismatch(d lockDecl, rs []lockRow, rankOf map[string]int, inst map[string]map[int]bool) string {
	table := make(map[int]bool)
	unranked := false
	for _, r := range rs {
		if r.rank == "-" {
			unranked = true
			continue
		}
		n, _ := strconv.Atoi(r.rank)
		table[n] = true
	}
	switch {
	case d.rank == "" && len(table) > 0:
		return fmt.Sprintf("lock %s is ranked %s in the table but declared as a plain mutex, which the deadlock build "+
			"cannot check; declare it syncutil.Ranked[R] (or RankedRW[R]) with that rank's type from %s", d.name, rankList(table), lockOrderFile)
	case d.rank == "":
		return ""
	case unranked:
		return fmt.Sprintf("lock %s is declared with rank type %s but its row is unranked; give the row the rank, or declare a plain mutex", d.name, d.rank)
	}
	var code map[int]bool
	if d.generic != "" {
		code = inst[d.generic]
		if len(code) == 0 {
			return fmt.Sprintf("lock %s takes its rank from %s[%s], which ws never instantiates with a rank type of %s", d.name, d.generic, d.rank, lockOrderFile)
		}
	} else {
		n, ok := rankOf[d.rank]
		if !ok {
			return fmt.Sprintf("lock %s is ranked by %s, which is not a rank type of %s (`func (%s) Rank() int { return N }`)", d.name, d.rank, lockOrderFile, d.rank)
		}
		code = map[int]bool{n: true}
	}
	if rankList(code) != rankList(table) {
		return fmt.Sprintf("lock %s has rank %s in the code but %s in the table of %s; the row and the rank type must agree",
			d.name, rankList(code), rankList(table), lockOrderFile)
	}
	return ""
}

func rankList(set map[int]bool) string {
	ns := make([]int, 0, len(set))
	for n := range set {
		ns = append(ns, n)
	}
	sort.Ints(ns)
	parts := make([]string, len(ns))
	for i, n := range ns {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, " and ")
}

// genericRanks maps each generic type of ws to the ranks it is instantiated
// with: directly (userLocks[lockRankVoiceMod]), or through another generic
// that passes its own type parameter on (userLocks[R] holds userLockEntry[R]).
func genericRanks(files []*ast.File, rankOf map[string]int) map[string]map[int]bool {
	generic := make(map[string]bool)
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			if ts, ok := n.(*ast.TypeSpec); ok && ts.TypeParams != nil {
				generic[ts.Name.Name] = true
			}
			return true
		})
	}
	inst := make(map[string]map[int]bool)
	passes := make(map[string][]string) // enclosing generic -> generics it passes its parameter to
	for _, f := range files {
		for _, u := range genericUnits(f) {
			owner, params := u.owner, u.params
			ast.Inspect(u.node, func(n ast.Node) bool {
				ix, ok := n.(*ast.IndexExpr)
				if !ok {
					return true
				}
				g, ok1 := ix.X.(*ast.Ident)
				arg, ok2 := ix.Index.(*ast.Ident)
				if !ok1 || !ok2 || !generic[g.Name] {
					return true
				}
				if n, ok := rankOf[arg.Name]; ok {
					addRank(inst, g.Name, n)
				} else if params[arg.Name] && g.Name != owner {
					passes[owner] = append(passes[owner], g.Name)
				}
				return true
			})
		}
	}
	for changed := true; changed; {
		changed = false
		for from, tos := range passes {
			for n := range inst[from] {
				for _, to := range tos {
					if !inst[to][n] {
						addRank(inst, to, n)
						changed = true
					}
				}
			}
		}
	}
	return inst
}

func addRank(inst map[string]map[int]bool, g string, n int) {
	if inst[g] == nil {
		inst[g] = make(map[int]bool)
	}
	inst[g][n] = true
}

// genericUnit is one declaration with the generic type it belongs to, if any.
type genericUnit struct {
	node   ast.Node
	owner  string
	params map[string]bool
}

// genericUnits splits a file into declarations, each tagged with its generic
// context: a generic type's own spec, or a method on one. A grouped type
// declaration is split per spec, so each spec gets its own parameters.
func genericUnits(f *ast.File) []genericUnit {
	var out []genericUnit
	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				u := genericUnit{node: spec}
				if ts, ok := spec.(*ast.TypeSpec); ok && ts.TypeParams != nil {
					u.owner, u.params = ts.Name.Name, typeParamNames(ts.TypeParams)
				}
				out = append(out, u)
			}
		case *ast.FuncDecl:
			u := genericUnit{node: d}
			u.owner, u.params = methodGeneric(d)
			out = append(out, u)
		}
	}
	return out
}

// methodGeneric names the generic receiver type of a method and its type
// parameters, or "" for a function or a method on a plain type.
func methodGeneric(d *ast.FuncDecl) (string, map[string]bool) {
	if d.Recv == nil || len(d.Recv.List) != 1 {
		return "", nil
	}
	t := d.Recv.List[0].Type
	if st, ok := t.(*ast.StarExpr); ok {
		t = st.X
	}
	if ix, ok := t.(*ast.IndexExpr); ok {
		base, ok1 := ix.X.(*ast.Ident)
		p, ok2 := ix.Index.(*ast.Ident)
		if ok1 && ok2 {
			return base.Name, map[string]bool{p.Name: true}
		}
	}
	return "", nil
}
