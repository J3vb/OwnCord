package invariants

import (
	"go/ast"
	"go/token"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// roleMirrorReadsID is the rule's stable id.
const roleMirrorReadsID = "role-mirror-reads"

// A member can hold several roles (user_roles); users.role_id is only the
// mirror of the TOP one, kept for old clients and for name and position reads.
// Reading a role's permission mask through it grants a holder only their top
// role's bits and silently drops every other role they hold -- the one
// authorization bug the multi-role model makes easy to write and hard to see.
// Authorization SQL joins user_roles instead (EXISTS over the held roles for a
// single-bit test, masks OR'd in Go for a full mask).
//
// The rule is syntactic: it flags SQL text (a Go string literal in a non-test
// file, or a db/queries/sqlite/*.sql file) that
//
//   - joins roles to a users row through role_id and reads that role's
//     permissions column (JOIN roles r ON r.id = u.role_id ... r.permissions), or
//   - tests role_id IN (SELECT id FROM roles WHERE ... permissions ...).
//
// Display reads of the mirror (the role's name, colour or position) are fine and
// are not flagged. There is no allow list: a site that truly needs the top
// role's mask reads db.MemberRoles.Top.Permissions from GetMemberRoles.
var roleMirrorReads = Rule{
	ID: roleMirrorReadsID,
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		var out []Violation
		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			text, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			if why := mirrorPermissionRead(text); why != "" {
				out = append(out, Violation{
					Rule: roleMirrorReadsID,
					File: rel,
					Line: fset.Position(lit.Pos()).Line,
					Msg:  roleMirrorReadsMsg(why),
				})
			}
			return true
		})
		return out
	},
	Tree: func(fsys fs.FS) []Violation {
		files, err := fs.Glob(fsys, "db/queries/sqlite/*.sql")
		if err != nil {
			return nil
		}
		sort.Strings(files)
		var out []Violation
		for _, name := range files {
			b, err := fs.ReadFile(fsys, name)
			if err != nil {
				continue
			}
			// One violation per offending statement, at the statement's first line.
			for _, stmt := range splitSQLStatements(string(b)) {
				if why := mirrorPermissionRead(stmt.text); why != "" {
					out = append(out, Violation{
						Rule: roleMirrorReadsID,
						File: path.Clean(name),
						Line: stmt.line,
						Msg:  roleMirrorReadsMsg(why),
					})
				}
			}
		}
		return out
	},
}

func roleMirrorReadsMsg(why string) string {
	return "reads a role's permissions through users.role_id (" + why + "). role_id mirrors only the member's " +
		"TOP role, so this ignores every other role they hold. Join user_roles instead: " +
		"EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND (r.permissions & ?) != 0) " +
		"for a bit test, or db.GetMemberRoles and its OR'd Perms in Go."
}

var (
	// JOIN roles <alias> ON ...  and  FROM roles <alias> WHERE ...  (RE2 has
	// no backreferences, so the condition after the alias is matched per alias
	// below).
	mirrorJoinHeadRE     = regexp.MustCompile(`(?i)\bjoin\s+roles(?:\s+as)?\s+(\w+)\s+on\s+`)
	mirrorSubqueryHeadRE = regexp.MustCompile(`(?i)\bfrom\s+roles(?:\s+as)?\s+(\w+)\s+where\s+`)
	// [<qualifier>.]role_id IN (SELECT id FROM roles ... permissions ...)
	mirrorInRE = regexp.MustCompile(`(?is)(?:\b(\w+)\.)?\brole_id\s+in\s*\(\s*select\s+id\s+from\s+roles\b[^;]*?\bpermissions\b`)
	// FROM|JOIN users [AS] alias
	usersAliasRE = regexp.MustCompile(`(?i)\b(?:from|join)\s+users\b(?:\s+(?:as\s+)?(\w+))?`)
)

// sqlKeywords are the words that can follow a table name without being its alias.
var sqlKeywords = map[string]bool{
	"where": true, "join": true, "left": true, "right": true, "inner": true, "outer": true, "cross": true,
	"on": true, "set": true, "order": true, "group": true, "limit": true, "union": true, "having": true,
	"natural": true, "using": true, "returning": true, "and": true, "or": true,
}

// usersAliases returns the names that refer to the users table in text: users
// itself and any alias given to it.
func usersAliases(text string) map[string]bool {
	out := map[string]bool{}
	for _, m := range usersAliasRE.FindAllStringSubmatch(text, -1) {
		out["users"] = true
		if a := strings.ToLower(m[1]); a != "" && !sqlKeywords[a] {
			out[a] = true
		}
	}
	return out
}

// mirrorCondition reports whether text, right after a "roles <alias> ON|WHERE"
// head ending at end, starts with the condition <alias>.id = <x>.role_id (either
// operand order) where <x> is the users table or an alias of it. user_roles
// carries a role_id column too, and joining through it is the fix, not the bug.
func mirrorCondition(text string, end int, alias string, users map[string]bool) bool {
	a := regexp.QuoteMeta(alias)
	re := regexp.MustCompile(`(?i)^(?:` + a + `\.id\s*=\s*(\w+)\.role_id|(\w+)\.role_id\s*=\s*` + a + `\.id)\b`)
	m := re.FindStringSubmatch(text[end:])
	if m == nil {
		return false
	}
	return users[strings.ToLower(m[1]+m[2])]
}

// readsAliasPermissions reports whether text reads <alias>.permissions.
func readsAliasPermissions(text, alias string) bool {
	return regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(alias) + `\.permissions\b`).MatchString(text)
}

// mirrorPermissionRead reports why text reads a role's permissions through a
// users.role_id join, or "" when it does not.
func mirrorPermissionRead(text string) string {
	if !strings.Contains(strings.ToLower(text), "role_id") {
		return ""
	}
	users := usersAliases(text)
	if len(users) == 0 {
		return ""
	}
	for _, m := range mirrorInRE.FindAllStringSubmatch(text, -1) {
		// A bare role_id belongs to the one table the statement reads; a
		// qualified one must be the users table. A statement that also reads
		// user_roles names its role_id columns by that table.
		if (m[1] != "" && users[strings.ToLower(m[1])]) || (m[1] == "" && !strings.Contains(strings.ToLower(text), "user_roles")) {
			return "an IN-subquery over roles.permissions"
		}
	}
	for _, head := range []*regexp.Regexp{mirrorJoinHeadRE, mirrorSubqueryHeadRE} {
		for _, m := range head.FindAllStringSubmatchIndex(text, -1) {
			alias := text[m[2]:m[3]]
			if mirrorCondition(text, m[1], alias, users) && readsAliasPermissions(text, alias) {
				return "roles " + alias + " joined on role_id, " + alias + ".permissions read"
			}
		}
	}
	return ""
}

type sqlStatement struct {
	text string
	line int
}

// splitSQLStatements splits a sqlc query file at each "-- name:" marker, so a
// violation reports the statement it is in rather than the whole file.
func splitSQLStatements(src string) []sqlStatement {
	var out []sqlStatement
	var cur strings.Builder
	start := 1
	flush := func() {
		if strings.TrimSpace(cur.String()) != "" {
			out = append(out, sqlStatement{text: cur.String(), line: start})
		}
		cur.Reset()
	}
	for i, line := range strings.Split(src, "\n") {
		if strings.HasPrefix(line, "-- name:") {
			flush()
			start = i + 1
		}
		cur.WriteString(line)
		cur.WriteByte('\n')
	}
	flush()
	return out
}
