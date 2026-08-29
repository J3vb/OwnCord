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
	tests := []struct {
		name string
		path string
		src  string
		want int
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
			path: "api/auth_handler.go",
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
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fset := token.NewFileSet()
			got := checkSourceWith([]Rule{dbImportBoundary}, fset, tt.path, []byte(tt.src))
			if len(got) != tt.want {
				t.Fatalf("want %d violation(s), got %d: %v", tt.want, len(got), got)
			}
			for _, v := range got {
				if v.Rule != dbImportBoundaryID {
					t.Errorf("rule id = %q, want %q", v.Rule, dbImportBoundaryID)
				}
				if !strings.Contains(v.Msg, "server-boundaries.md") {
					t.Errorf("message must point at the inventory document: %q", v.Msg)
				}
			}
		})
	}
}

// TestDBImportAllowIsLive keeps the inventory honest in the other direction:
// every allowlisted path must exist and still import db. A row for a file
// that moved behind a service (or was renamed) is stale and must be deleted —
// the list only shrinks.
func TestDBImportAllowIsLive(t *testing.T) {
	for rel, entry := range DBImportAllow {
		p := filepath.Join("..", filepath.FromSlash(rel))
		src, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("DBImportAllow[%q]: %v — delete the row", rel, err)
			continue
		}
		if !strings.Contains(string(src), `"`+dbImportPath+`"`) {
			t.Errorf("DBImportAllow[%q] no longer imports db — delete the row", rel)
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
