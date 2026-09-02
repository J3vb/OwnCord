package api_test

import (
	"context"
	"database/sql"
	"go/parser"
	"go/token"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/go-chi/chi/v5"
)

// BPR-043: email is optional, and registration and recovery work without
// SMTP or any central service. At `aabac60` that holds by absence — there is
// no email column, no mail transport and no mail configuration — and these
// tests pin the absence at the four boundaries a dependency would have to
// cross: an import, a module requirement, a configuration key, a schema
// column (plus the route boundary the B2 absence contract already walks).
// They pin vocabulary, like absence_contract_test.go: the day the owner
// decides optional SMTP recovery is in scope (B4 plan, owner question 7),
// the dependency is added deliberately and this file changes with it.
//
// mailPattern names a transport, a mailbox, or the word "mail" itself at a
// name boundary: "e-mail" / "email" catch a column or a key, the vendor names
// catch the usual clients, and the bare word catches conventional transport
// and path names — "go-mail", "mail_address", "/mail/recovery" — without
// matching words that merely contain the letters. Nothing in the tree
// collides today; a legitimate collision is allowlisted by name here, never
// by loosening the pattern.
var mailPattern = regexp.MustCompile(`(?i)smtp|sendgrid|mailgun|postmark|sendmail|gomail|mailer|e-?mail|/ses$|(?:^|[^a-z0-9])mail(?:[^a-z0-9]|$)`)

// scanImports parses every production .go file under root (tests and the
// generated sqlc layer excluded) and returns how many it read and the import
// paths matching mailPattern, as "rel/path.go: import".
func scanImports(root string) (files int, hits []string, err error) {
	fset := token.NewFileSet()
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "testdata", "dbgen":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, parseErr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if parseErr != nil {
			return parseErr
		}
		files++
		rel, _ := filepath.Rel(root, path)
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if mailPattern.MatchString(p) {
				hits = append(hits, filepath.ToSlash(rel)+": "+p)
			}
		}
		return nil
	})
	return files, hits, err
}

// scanColumns lists every "table.column" in sqlDB whose table or column name
// matches mailPattern, and how many tables it inspected.
func scanColumns(ctx context.Context, sqlDB *sql.DB) (tables int, hits []string, err error) {
	rows, err := sqlDB.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return 0, nil, err
	}
	var names []string
	for rows.Next() {
		var n string
		if scanErr := rows.Scan(&n); scanErr != nil {
			_ = rows.Close()
			return 0, nil, scanErr
		}
		names = append(names, n)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	for _, table := range names {
		tables++
		if mailPattern.MatchString(table) {
			hits = append(hits, table)
		}
		// PRAGMA takes no bind parameters; the name came from sqlite_master.
		cols, err := sqlDB.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
		if err != nil {
			return tables, hits, err
		}
		for cols.Next() {
			var col string
			if scanErr := cols.Scan(&col); scanErr != nil {
				_ = cols.Close()
				return tables, hits, scanErr
			}
			if mailPattern.MatchString(col) {
				hits = append(hits, table+"."+col)
			}
		}
		_ = cols.Close()
		if err := cols.Err(); err != nil {
			return tables, hits, err
		}
	}
	return tables, hits, nil
}

func TestAbsenceContract_NoMailTransportImport(t *testing.T) {
	files, hits, err := scanImports("..")
	if err != nil {
		t.Fatalf("scanning Server/: %v", err)
	}
	// 237 at aabac60 with tests and the generated sqlc layer excluded; the
	// guard only has to catch a walk that lost the tree, not track growth.
	if files < 200 {
		t.Fatalf("parsed only %d production files; expected the whole server tree (>= 200)", files)
	}
	if len(hits) > 0 {
		t.Fatalf("production imports matching %q must not exist (BPR-043; see the B4 plan, owner question 7):\n  %s",
			mailPattern, strings.Join(hits, "\n  "))
	}
}

// scanModuleLines returns the go.mod lines matching mailPattern, trimmed.
func scanModuleLines(gomod string) []string {
	var hits []string
	for line := range strings.SplitSeq(gomod, "\n") {
		if mailPattern.MatchString(line) {
			hits = append(hits, strings.TrimSpace(line))
		}
	}
	return hits
}

// scanConfigKeys returns the configuration keys matching mailPattern, as
// "config key <key>".
func scanConfigKeys(keys []string) []string {
	var hits []string
	for _, k := range keys {
		if mailPattern.MatchString(k) {
			hits = append(hits, "config key "+k)
		}
	}
	return hits
}

// scanRoutes walks routes and returns how many it saw and the ones matching
// mailPattern, as "route <METHOD> <pattern>".
func scanRoutes(routes chi.Routes) (total int, hits []string, err error) {
	err = chi.Walk(routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		total++
		if mailPattern.MatchString(route) {
			hits = append(hits, "route "+method+" "+route)
		}
		return nil
	})
	return total, hits, err
}

func TestAbsenceContract_NoMailModuleRequirement(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "go.mod"))
	if err != nil {
		t.Fatalf("read go.mod: %v", err)
	}
	if hits := scanModuleLines(string(raw)); len(hits) > 0 {
		t.Fatalf("go.mod lines matching %q must not exist (BPR-043):\n  %s", mailPattern, strings.Join(hits, "\n  "))
	}
}

func TestAbsenceContract_NoMailConfigKeyOrRoute(t *testing.T) {
	keys := koanfKeys(reflect.TypeFor[config.Config](), "")
	if len(keys) < 30 {
		t.Fatalf("collected only %d config keys; expected the full config surface (>= 30)", len(keys))
	}
	hits := scanConfigKeys(keys)

	handler := fullRouter(t)
	routes, ok := handler.(chi.Routes)
	if !ok {
		t.Fatalf("NewRouter returned %T, want a chi.Routes", handler)
	}
	total, routeHits, err := scanRoutes(routes)
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	hits = append(hits, routeHits...)
	if total < 100 {
		t.Fatalf("walked only %d routes; expected the full production router (>= 100)", total)
	}
	if len(hits) > 0 {
		t.Fatalf("configuration keys or routes matching %q must not exist (BPR-043):\n  %s", mailPattern, strings.Join(hits, "\n  "))
	}
}

func TestAbsenceContract_NoEmailColumn(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	tables, hits, err := scanColumns(context.Background(), database.SQLDb())
	if err != nil {
		t.Fatalf("scanning schema: %v", err)
	}
	if tables < 20 {
		t.Fatalf("inspected only %d tables; expected the migrated schema (>= 20)", tables)
	}
	if len(hits) > 0 {
		t.Fatalf("tables or columns matching %q must not exist (BPR-043 — email is not stored):\n  %s", mailPattern, strings.Join(hits, "\n  "))
	}
}

// The negative controls: each scanner must report a planted dependency, or a
// green run above proves only that the scanner ran.

func TestAbsenceContract_ImportScannerNegativeControl(t *testing.T) {
	dir := t.TempDir()
	probe := "package probe\n\nimport _ \"net/smtp\"\n"
	if err := os.WriteFile(filepath.Join(dir, "probe.go"), []byte(probe), 0o600); err != nil {
		t.Fatalf("write probe: %v", err)
	}
	files, hits, err := scanImports(dir)
	if err != nil {
		t.Fatalf("scanImports: %v", err)
	}
	if files != 1 || len(hits) != 1 || hits[0] != "probe.go: net/smtp" {
		t.Fatalf("negative control: files=%d hits=%v, want the planted net/smtp import reported once", files, hits)
	}
}

func TestAbsenceContract_ColumnScannerNegativeControl(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	sqlDB := database.SQLDb()
	if _, err := sqlDB.ExecContext(context.Background(), `CREATE TABLE contacts (id INTEGER PRIMARY KEY, email TEXT)`); err != nil {
		t.Fatalf("create probe table: %v", err)
	}
	_, hits, err := scanColumns(context.Background(), sqlDB)
	if err != nil {
		t.Fatalf("scanColumns: %v", err)
	}
	if len(hits) != 1 || hits[0] != "contacts.email" {
		t.Fatalf("negative control: hits=%v, want the planted contacts.email column reported once", hits)
	}
}

func TestAbsenceContract_ModuleScannerNegativeControl(t *testing.T) {
	// A conventional transport name that carries neither "smtp" nor a vendor
	// name — exactly what the bare-word boundary rule in mailPattern is for.
	gomod := "module example.com/probe\n\ngo 1.26\n\nrequire (\n\tgithub.com/go-chi/chi/v5 v5.2.0\n\tgithub.com/wneessen/go-mail v0.6.2\n)\n"
	hits := scanModuleLines(gomod)
	if len(hits) != 1 || hits[0] != "github.com/wneessen/go-mail v0.6.2" {
		t.Fatalf("negative control: hits=%v, want the planted go-mail requirement reported once", hits)
	}
}

func TestAbsenceContract_ConfigKeyScannerNegativeControl(t *testing.T) {
	hits := scanConfigKeys([]string{"server.port", "auth.mail_address", "storage.dir"})
	if len(hits) != 1 || hits[0] != "config key auth.mail_address" {
		t.Fatalf("negative control: hits=%v, want the planted mail_address key reported once", hits)
	}
}

func TestAbsenceContract_RouteScannerNegativeControl(t *testing.T) {
	r := chi.NewRouter()
	noContent := func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }
	r.Get("/api/v1/health", noContent)
	r.Post("/api/v1/auth/mail/recovery", noContent)
	total, hits, err := scanRoutes(r)
	if err != nil {
		t.Fatalf("scanRoutes: %v", err)
	}
	if total != 2 || len(hits) != 1 || hits[0] != "route POST /api/v1/auth/mail/recovery" {
		t.Fatalf("negative control: total=%d hits=%v, want the planted mail route reported once", total, hits)
	}
}

func TestAbsenceContract_MailPatternBoundaries(t *testing.T) {
	// The bare word matches at name boundaries only; the vendor and mailbox
	// terms carry the rest. Pinned so a later edit cannot quietly drop either.
	for _, s := range []string{"github.com/wneessen/go-mail", "mail_address", "/mail/recovery", "net/mail", "MAIL", "email", "e-mail", "net/smtp", "mailer", "gomail"} {
		if !mailPattern.MatchString(s) {
			t.Errorf("%q must match mailPattern", s)
		}
	}
	for _, s := range []string{"server.port", "/api/v1/messages", "airmail_free", "domain", "mailbox_unused_letters_in_mailman"} {
		if mailPattern.MatchString(s) {
			t.Errorf("%q must not match mailPattern", s)
		}
	}
}
