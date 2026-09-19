package invariants

import (
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDBImportBoundary(t *testing.T) {
	const importDB = `import "github.com/J3vb/OwnCord/Server/db"`
	const importSQL = "import (\n\t\"database/sql\"\n\t" + `"github.com/J3vb/OwnCord/Server/db"` + "\n)"
	tests := []struct {
		name string
		path string
		src  string
		want int
		rule string // the id the violations must carry; "" means db-import-boundary
	}{
		{
			name: "unlisted api file importing db is flagged",
			path: "api/brand_new_handler.go",
			src:  "package api\n" + importDB + "\nvar _ *db.DB\n",
			want: 1,
		},
		{
			name: "aliased import is still flagged",
			path: "ws/brand_new.go",
			src:  "package ws\nimport store \"github.com/J3vb/OwnCord/Server/db\"\nvar _ *store.DB\n",
			want: 1,
		},
		{
			name: "listed file is allowed",
			path: "api/middleware.go",
			src:  "package api\n" + importDB + "\nvar _ *db.DB\n",
			want: 0,
		},
		{
			name: "service may import db",
			path: "service/anything.go",
			src:  "package service\n" + importDB + "\nvar _ *db.DB\n",
			want: 0,
		},
		{
			name: "db itself is out of scope",
			path: "db/anything.go",
			src:  "package db\n" + importDB + "\n",
			want: 0,
		},
		{
			name: "unlisted file without the import is clean",
			path: "api/brand_new_handler.go",
			src:  "package api\nimport \"net/http\"\nvar _ http.Handler\n",
			want: 0,
		},
		{
			name: "a sibling module path is not the db package",
			path: "api/brand_new_handler.go",
			src:  "package api\nimport \"github.com/J3vb/OwnCord/Server/db/dbgen\"\nvar _ dbgen.Queries\n",
			want: 0,
		},
		// ── db-handle-owner: use, not import (B6-14) ──────────────────────────
		{
			name: "an adapter row reaching the raw pool is flagged",
			path: "api/dm_handler.go",
			src:  "package api\n" + importDB + "\nfunc f(d *db.DB) { _ = d.SQLDb() }\n",
			want: 1,
			rule: dbHandleOwnerID,
		},
		{
			name: "the reader pool is the same escape, through a package field",
			path: "ws/handlers.go",
			src:  "package ws\nfunc f(h *Hub) { _ = h.db.SQLReaderDB() }\n",
			want: 1,
			rule: dbHandleOwnerID,
		},
		{
			name: "an adapter row opening a transaction is flagged",
			path: "api/dm_handler.go",
			src:  "package api\n" + importDB + "\nfunc f(d *db.DB) { _, _ = d.BeginTx(nil, nil) }\n",
			want: 1,
			rule: dbHandleOwnerID,
		},
		{
			name: "BeginTx through a field this file declares is still the handle",
			path: "api/dm_handler.go",
			src:  "package api\n" + importDB + "\ntype adapter struct{ database *db.DB }\nfunc f(a *adapter) { _, _ = a.database.BeginTx(nil, nil) }\n",
			want: 1,
			rule: dbHandleOwnerID,
		},
		{
			name: "BeginTx on something that is not the db handle is not ours",
			path: "api/dm_handler.go",
			src:  "package api\n" + importDB + "\nvar _ *db.DB\nfunc f(q queue) { q.BeginTx() }\n",
			want: 0,
		},
		{
			name: "an adapter row threading a *sql.Tx is flagged",
			path: "api/dm_handler.go",
			src:  "package api\n" + importSQL + "\nvar _ *db.DB\nfunc f(tx *sql.Tx) {}\n",
			want: 1,
			rule: dbHandleOwnerID,
		},
		{
			name: "a boundary row owns its raw handle",
			path: "cmd/seed/profile_alpha.go",
			src:  "package main\n" + importSQL + "\nfunc f(d *db.DB) (*sql.Tx, error) { return d.BeginTx(nil, nil) }\n",
			want: 0,
		},
		{
			name: "database/sql without the db import is not this rule's business",
			path: "cmd/smoke/drills.go",
			src:  "package main\nimport \"database/sql\"\nfunc f() (*sql.DB, error) { return sql.Open(\"x\", \"y\") }\n",
			want: 0,
		},
		{
			name: "sql values that are not handles are left alone",
			path: "api/dm_handler.go",
			src:  "package api\n" + importSQL + "\nvar _ *db.DB\nfunc f(s sql.DBStats) error { return sql.ErrNoRows }\n",
			want: 0,
		},
		{
			name: "the allow comment must name the sub-id",
			path: "api/dm_handler.go",
			src:  "package api\n" + importDB + "\nfunc f(d *db.DB) { _ = d.SQLDb() } //invariant:allow db-handle-owner — probe\n",
			want: 0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fset := token.NewFileSet()
			got := checkSourceWith([]Rule{dbImportBoundary}, fset, tt.path, []byte(tt.src))
			if len(got) != tt.want {
				t.Fatalf("want %d violation(s), got %d: %v", tt.want, len(got), got)
			}
			wantRule := tt.rule
			if wantRule == "" {
				wantRule = dbImportBoundaryID
			}
			for _, v := range got {
				if v.Rule != wantRule {
					t.Errorf("rule id = %q, want %q", v.Rule, wantRule)
				}
				if !strings.Contains(v.Msg, "server-boundaries.md") {
					t.Errorf("message must point at the inventory document: %q", v.Msg)
				}
			}
		})
	}
}

// TestDBImportAllowIsLive keeps the inventory honest in the other direction:
// every allowlisted path must exist and still use db. A row for a file that
// moved behind a service (or was renamed) is stale and must be deleted — the
// list only shrinks.
//
// "Uses db" is two things since B6-14, because an import is not the access:
// the file imports the package, OR it pins a call or a hand-off, which is how
// a file that reaches the handle through a package field earns a row. A row
// with neither is still rejected — that is the shrink the list promises.
// Whether the pinned multiset is the one the tree measures is the document
// gate's half of the check (cmd/dbinventory), which has the package-wide view
// this test does not.
func TestDBImportAllowIsLive(t *testing.T) {
	for rel, entry := range DBImportAllow {
		p := filepath.Join("..", filepath.FromSlash(rel))
		src, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("DBImportAllow[%q]: %v — delete the row", rel, err)
			continue
		}
		if !strings.Contains(string(src), `"`+dbImportPath+`"`) && len(entry.Calls)+len(entry.Hands) == 0 {
			t.Errorf("DBImportAllow[%q] neither imports db nor pins a call or hand-off — delete the row", rel)
		}
		if entry.Disposition != DispositionBoundary && len(entry.Calls)+len(entry.Hands) > 0 {
			t.Errorf("DBImportAllow[%q]: a %s row pins %d call(s) and %d hand-off(s); only a boundary row owns handle use",
				rel, entry.Disposition, len(entry.Calls), len(entry.Hands))
		}
		switch entry.Disposition {
		case "move":
			if entry.Family == "" {
				t.Errorf("DBImportAllow[%q]: a move needs a target family", rel)
			}
		case "adapter", "boundary", "remove":
			if entry.Family != "" {
				t.Errorf("DBImportAllow[%q]: %s rows carry no family", rel, entry.Disposition)
			}
		default:
			t.Errorf("DBImportAllow[%q]: unknown disposition %q", rel, entry.Disposition)
		}
		if entry.Note == "" {
			t.Errorf("DBImportAllow[%q]: the reason is mandatory", rel)
		}
	}
}
