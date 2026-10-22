package invariants

import (
	"go/token"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// TestRoleMirrorReads is the ratchet behind WP 6.3b: nothing reads a role's
// permissions through users.role_id. The fixtures cover each spelling of the
// join and what is not a violation; the last two cases run the rule over the
// real tree (Go string literals through the walker, and the sqlc query files).
func TestRoleMirrorReads(t *testing.T) {
	goSnippet := func(sql string) string {
		return "package db\nconst q = `" + sql + "`\n"
	}
	tests := []struct {
		name string
		sql  string
		want int
	}{
		{
			name: "join on the mirror reading the mask is flagged",
			sql:  `SELECT r.permissions FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
			want: 1,
		},
		{
			name: "either operand order is the same join",
			sql:  `SELECT 1 FROM users u JOIN roles r ON u.role_id = r.id WHERE (r.permissions & ?) != 0`,
			want: 1,
		},
		{
			name: "AS alias, line breaks and upper case do not hide it",
			sql:  "SELECT COUNT(*)\n FROM users u\n JOIN roles AS rr\n   ON rr.id =\n u.role_id\n WHERE (RR.PERMISSIONS & ?) != 0",
			want: 1,
		},
		{
			name: "role_id IN (SELECT id FROM roles ... permissions) is flagged",
			sql:  `SELECT COUNT(*) FROM users WHERE role_id IN (SELECT id FROM roles WHERE id IN (?, ?) OR (permissions & ?) != 0)`,
			want: 1,
		},
		{
			name: "a correlated subquery on the mirror is flagged",
			sql:  `SELECT (SELECT r.permissions FROM roles r WHERE r.id = users.role_id) FROM users`,
			want: 1,
		},
		{
			name: "reading the role's name or position through the mirror is display, not authorization",
			sql:  `SELECT LOWER(r.name), r.position FROM users u JOIN roles r ON u.role_id = r.id`,
			want: 0,
		},
		{
			name: "the held-roles join is the fix",
			sql:  `SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
			want: 0,
		},
		{
			name: "a different alias reading permissions is not the mirror join",
			sql:  `SELECT o.permissions FROM users u JOIN roles r ON r.id = u.role_id JOIN roles o ON o.id = 1`,
			want: 0,
		},
		{
			name: "roles listing by permission bit without a user join is fine",
			sql:  `SELECT id FROM roles WHERE id IN (?, ?) OR (permissions & ?) != 0`,
			want: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := checkSourceWith([]Rule{roleMirrorReads}, token.NewFileSet(), "db/example.go", []byte(goSnippet(tt.sql)))
			if len(got) != tt.want {
				t.Fatalf("Go literal: %d violation(s), want %d: %v", len(got), tt.want, got)
			}
			fsys := fstest.MapFS{"db/queries/sqlite/x.sql": {Data: []byte("-- name: A :one\nSELECT 1;\n\n-- name: B :one\n" + tt.sql + ";\n")}}
			tree := roleMirrorReads.Tree(fsys)
			if len(tree) != tt.want {
				t.Fatalf("sql file: %d violation(s), want %d: %v", len(tree), tt.want, tree)
			}
			for _, v := range tree {
				if v.Line != 4 {
					t.Errorf("the violation is reported at line %d, want the statement's own line 4", v.Line)
				}
			}
		})
	}

	t.Run("the message names the fix", func(t *testing.T) {
		got := checkSourceWith([]Rule{roleMirrorReads}, token.NewFileSet(), "db/example.go",
			[]byte(goSnippet(`SELECT r.permissions FROM users u JOIN roles r ON r.id = u.role_id`)))
		if len(got) != 1 || !strings.Contains(got[0].Msg, "user_roles") {
			t.Fatalf("message = %v, want it to point at user_roles", got)
		}
	})

	t.Run("sqlc query files in the real tree", func(t *testing.T) {
		root, err := os.OpenRoot("..")
		if err != nil {
			t.Fatalf("OpenRoot: %v", err)
		}
		defer root.Close() //nolint:errcheck
		if vs := roleMirrorReads.Tree(root.FS()); len(vs) != 0 {
			for _, v := range vs {
				t.Error(v)
			}
		}
	})

	t.Run("Go sources in the real tree", func(t *testing.T) {
		vs, err := runWith([]Rule{roleMirrorReads}, "..")
		if err != nil {
			t.Fatalf("runWith: %v", err)
		}
		for _, v := range vs {
			t.Error(v)
		}
	})
}
