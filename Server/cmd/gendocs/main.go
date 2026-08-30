// Command gendocs regenerates the machine-readable index blocks that pin the
// server's three contracts to the documents describing them:
//
//	routes  -> docs/api.md                   every route the mounted chi tree serves
//	schema  -> docs/schema.md                every table the migrations create
//	config  -> docs/server-configuration.md  every koanf key, and where it is documented
//
// Each index replaces the text between a pair of HTML-comment markers
// (<!-- gendocs:NAME:start --> … <!-- gendocs:NAME:end -->). Everything
// hand-written around them is left alone. Run it from Server/:
//
//	go run ./cmd/gendocs
//
// `make docs-verify` runs that and then `git diff --exit-code` on the three
// documents, so a route, table or config key that changes in code without
// reaching the docs fails the build — the same shape as protocol-verify and
// sqlc-verify.
//
// Two sources are read the way the absence-contract tests read them, because
// no non-test seam exists: the router is rebuilt with every optional family
// switched on and walked with chi.Walk, and the config surface comes from
// reflection over the koanf struct tags. The schema comes from an in-memory
// database with the migrations applied — sqlc exposes no catalog, so the
// migrated database is the catalog.
//
// Output is padded exactly the way Prettier formats a Markdown table, so the
// generated blocks survive the repository's `prettier --check` gate.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
	"github.com/go-chi/chi/v5"
)

// Documents rewritten, relative to Server/ (the directory the tool runs in).
const (
	apiDoc    = "../docs/api.md"
	schemaDoc = "../docs/schema.md"
	configDoc = "../docs/server-configuration.md"
)

// regenCmd is quoted into every generated block so a reader who spots a stale
// row knows what to run without going looking for it.
const regenCmd = "cd Server && go run -tags otel,wazero ./cmd/gendocs"

// minRoutes is the vacuity floor the route index inherits from
// TestAbsenceContract_NoFederationDirectoryOrListingRoutes: a walk over an
// empty or wrapped mux would otherwise produce a short table that diffs clean
// on the next run. An empty table is drift too.
const minRoutes = 100

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "gendocs:", err)
		os.Exit(1)
	}
}

func run() error {
	for _, g := range []struct {
		name string
		path string
		gen  func(io.Writer) error
	}{
		{"routes", apiDoc, genRoutes},
		{"schema", schemaDoc, genSchema},
		{"config", configDoc, genConfig},
	} {
		var buf bytes.Buffer
		if err := g.gen(&buf); err != nil {
			return fmt.Errorf("%s index: %w", g.name, err)
		}
		raw, err := os.ReadFile(g.path)
		if err != nil {
			return err
		}
		out, err := spliceBlock(string(raw), g.name, buf.String())
		if err != nil {
			return fmt.Errorf("%s: %w", g.path, err)
		}
		if out == string(raw) {
			continue
		}
		//nolint:gosec // G703: g.path is one of the three constants above, never input.
		if err := os.WriteFile(g.path, []byte(out), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// spliceBlock replaces the text between the gendocs markers for name with
// body, leaving the markers and everything around them untouched. Missing
// markers are an error rather than an append: where a block lives is a
// hand-made editorial decision, not something a generator should guess.
func spliceBlock(doc, name, body string) (string, error) {
	start := "<!-- gendocs:" + name + ":start -->"
	end := "<!-- gendocs:" + name + ":end -->"
	i := strings.Index(doc, start)
	j := strings.Index(doc, end)
	if i < 0 || j < 0 {
		return "", fmt.Errorf("markers %q … %q not found; add the block by hand once, then this tool fills it", start, end)
	}
	if j < i+len(start) {
		return "", fmt.Errorf("marker %q appears before %q", end, start)
	}
	return doc[:i+len(start)] + "\n\n" + strings.Trim(body, "\n") + "\n\n" + doc[j:], nil
}

// writeTable renders a GitHub-flavoured Markdown table padded the way Prettier
// formats one: every cell in a column padded to the widest cell in that
// column (the header included, minimum three), and the separator row filled
// with that many dashes. Emitting anything else means `prettier --check` and
// `git diff --exit-code` fight each other forever, each undoing the other.
func writeTable(w io.Writer, header []string, rows [][]string) {
	// ponytail: widths are rune counts, Prettier's are display widths — a
	// full-width CJK or emoji cell would pad two columns narrow. No generated
	// cell holds one (route paths, SQL identifiers, config keys, section
	// headings); switch to a display-width count if that ever changes.
	widths := make([]int, len(header))
	cells := make([][]string, 0, len(rows)+1)
	for _, r := range append([][]string{header}, rows...) {
		row := make([]string, len(header))
		for i := range header {
			if i < len(r) {
				row[i] = escapeCell(r[i])
			}
			widths[i] = max(widths[i], utf8.RuneCountInString(row[i]), 3)
		}
		cells = append(cells, row)
	}
	printRow := func(r []string) {
		for i, c := range r {
			r[i] = c + strings.Repeat(" ", widths[i]-utf8.RuneCountInString(c))
		}
		printf(w, "| %s |\n", strings.Join(r, " | "))
	}
	printRow(cells[0])
	sep := make([]string, len(header))
	for i := range sep {
		sep[i] = strings.Repeat("-", widths[i])
	}
	printf(w, "| %s |\n", strings.Join(sep, " | "))
	for _, r := range cells[1:] {
		printRow(r)
	}
}

// printf writes formatted output to w. Every w here is an in-memory buffer
// that run() then splices into a document, so a write error is not reachable
// and dropping it once beats five checks that can never fire.
func printf(w io.Writer, format string, a ...any) {
	_, _ = fmt.Fprintf(w, format, a...)
}

// escapeCell hides the one character that would end a cell early. Prettier
// writes the same escape, so an escaped pipe round-trips.
func escapeCell(s string) string { return strings.ReplaceAll(s, "|", `\|`) }

// code wraps s in a Markdown code span.
func code(s string) string { return "`" + s + "`" }

// joinCode renders a list of identifiers as comma-separated code spans, or an
// em dash when there are none, matching cmd/dbinventory's table style.
func joinCode(items []string) string {
	if len(items) == 0 {
		return "—"
	}
	return code(strings.Join(items, "`, `"))
}

// openMigrated opens an in-memory database with every migration applied. It is
// the schema catalog and the router's dependency both.
func openMigrated() (*db.DB, func(), error) {
	database, err := db.Open(":memory:")
	if err != nil {
		return nil, nil, fmt.Errorf("db.Open: %w", err)
	}
	if err := db.Migrate(database); err != nil {
		_ = database.Close()
		return nil, nil, fmt.Errorf("db.Migrate: %w", err)
	}
	return database, func() { _ = database.Close() }, nil
}

// genRoutes walks the production router with every optional family switched
// on — uploads, voice, the GIF proxy and telemetry — so the table is the
// whole tree rather than the bare-config subset. The scaffolding is a copy of
// fullRouter in api/absence_contract_test.go plus the telemetry init main.go
// does; test code stays in the test.
//
// The index is the superset build: /metrics mounts only when
// telemetry.PrometheusHandler() returns non-nil, which needs -tags otel, so
// every invocation of this tool passes -tags otel,wazero. Nothing under
// Server/api or Server/admin is itself tag-gated, so wazero adds and removes
// no route; it rides along so one build serves the whole repository.
func genRoutes(w io.Writer) error {
	database, closeDB, err := openMigrated()
	if err != nil {
		return err
	}
	defer closeDB()

	dir, err := os.MkdirTemp("", "gendocs")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	cfg := &config.Config{
		Server: config.ServerConfig{Name: "gendocs", Port: 8443, DataDir: dir},
		Upload: config.UploadConfig{MaxSizeMB: 1, StorageDir: filepath.Join(dir, "uploads")},
		//nolint:gosec // G101: placeholder values so the optional voice routes mount; the router is walked, never served.
		Voice: config.VoiceConfig{
			LiveKitAPIKey:    "gendocs-key",
			LiveKitAPISecret: "gendocs-secret-at-least-32-chars-long",
			LiveKitURL:       "ws://127.0.0.1:7880",
		},
		GIF: config.GIFConfig{APIKey: "gendocs"},
		// /metrics mounts only when telemetry.PrometheusHandler() is non-nil,
		// which needs both the otel build tag and telemetry switched on at
		// runtime. Without this the index would silently omit a production
		// route.
		Telemetry: config.TelemetryConfig{Enabled: true, Exporter: "prometheus", ServiceName: "gendocs"},
	}

	ctx := context.Background()
	shutdown, err := telemetry.Init(ctx, cfg.Telemetry)
	if err != nil {
		return fmt.Errorf("telemetry.Init: %w", err)
	}
	defer func() { _ = shutdown(ctx) }()
	// The default build's Init installs a no-op provider, so this is the
	// runtime check that the tool was built the way the index claims.
	if telemetry.PrometheusHandler() == nil {
		return errors.New("telemetry.Init left no Prometheus handler: run this tool as `go run -tags otel,wazero ./cmd/gendocs`, the build the route index is generated from")
	}

	handler, _, cleanup := api.NewRouter(cfg, database, "gendocs", nil, nil)
	defer cleanup()

	routes, ok := handler.(chi.Routes)
	if !ok {
		return fmt.Errorf("api.NewRouter returned %T, want a chi.Routes so the mounted tree can be walked", handler)
	}
	var rows [][]string
	admin := 0
	walk := func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		// A real admin subroute, not the per-method `/admin/*` catch-all chi
		// emits for the Mount itself — those appear whether or not the walk
		// ever descended into the subrouter.
		if strings.HasPrefix(route, "/admin/api/") && !strings.HasSuffix(route, "/*") {
			admin++
		}
		rows = append(rows, []string{method, route})
		return nil
	}
	if err := chi.Walk(routes, walk); err != nil {
		return fmt.Errorf("chi.Walk: %w", err)
	}
	if len(rows) < minRoutes {
		return fmt.Errorf("walked only %d routes; expected the full production router (>= %d)", len(rows), minRoutes)
	}
	if admin == 0 {
		return errors.New("walk saw no /admin/api/ routes; the mounted admin subrouter was not traversed")
	}
	// chi hands the methods of one pattern back in map order, so the sort is
	// what makes two runs produce the same bytes. Sorted on the bare path,
	// before the code span goes on: a trailing backtick would order
	// `/x` after `/x/y`.
	slices.SortFunc(rows, cmpRoute)
	for _, r := range rows {
		r[1] = code(r[1])
	}

	printf(w, "Generated from the mounted router by %s — do not edit by hand; `make docs-verify` fails when it drifts. %d routes, from the `otel,wazero` build with every optional family enabled (uploads, voice, the GIF proxy, and telemetry with the Prometheus exporter, which is what mounts `/metrics`).\n\n",
		code(regenCmd), len(rows))
	writeTable(w, []string{"Method", "Path"}, rows)
	return nil
}

// cmpRoute orders {method, path} rows by path, then method.
func cmpRoute(a, b []string) int {
	if c := strings.Compare(a[1], b[1]); c != 0 {
		return c
	}
	return strings.Compare(a[0], b[0])
}

// genSchema reads the catalog of the migrated database. sqlc has no catalog
// export (Server/sqlc.yaml declares no plugins and takes its schema from
// migrations/), so the migrated database is the catalog — the same trick the
// absence contract's fullRouter uses to get a real schema without a file.
//
// sqlite_sequence and the FTS5 shadow tables behind messages_fts are kept:
// they are what the migrations create, and a change to either is a schema
// change worth seeing in the diff. The sqlite_stat* tables are dropped —
// db.Migrate runs ANALYZE after applying migrations, so they hold planner
// statistics rather than schema, and which of them exists is a property of
// the SQLite build (sqlite_stat4 only with STAT4 compiled in). Including them
// would fail this drift check on a modernc.org/sqlite bump.
func genSchema(w io.Writer) error {
	database, closeDB, err := openMigrated()
	if err != nil {
		return err
	}
	defer closeDB()

	ctx := context.Background()
	// GLOB, not LIKE: LIKE's "_" is a wildcard, GLOB's is not.
	tables, err := queryStrings(ctx, database,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_stat*' ORDER BY name`)
	if err != nil {
		return err
	}
	if len(tables) == 0 {
		return errors.New("the migrated database reports no tables; the catalog read is broken")
	}
	rows := make([][]string, 0, len(tables))
	for _, t := range tables {
		cols, err := tableColumns(ctx, database, t)
		if err != nil {
			return err
		}
		idx, err := queryStrings(ctx, database,
			`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, t)
		if err != nil {
			return err
		}
		rows = append(rows, []string{code(t), joinCode(cols), joinCode(idx)})
	}

	printf(w, "Generated from the migrated schema by %s — do not edit by hand; `make docs-verify` fails when it drifts. %d tables: `sqlite_sequence` and the FTS5 shadow tables behind `messages_fts` are included; the `sqlite_stat*` tables `ANALYZE` writes are not, since they hold planner statistics and which of them exists depends on the SQLite build.\n\n",
		code(regenCmd), len(rows))
	writeTable(w, []string{"Table", "Columns", "Indexes"}, rows)
	return nil
}

// tableColumns renders one table's columns in declaration order as
// "name TYPE" with the NOT NULL and PK flags PRAGMA table_info reports.
func tableColumns(ctx context.Context, database *db.DB, table string) ([]string, error) {
	rows, err := database.QueryContext(ctx,
		`SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid`, table)
	if err != nil {
		return nil, fmt.Errorf("pragma_table_info(%s): %w", table, err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var name, typ string
		var notNull, pk int
		if err := rows.Scan(&name, &typ, &notNull, &pk); err != nil {
			return nil, err
		}
		col := name
		if typ != "" {
			col += " " + typ
		}
		if notNull != 0 {
			col += " NOT NULL"
		}
		if pk != 0 {
			col += " PK"
		}
		out = append(out, col)
	}
	return out, rows.Err()
}

// queryStrings runs a query whose rows are a single string column.
func queryStrings(ctx context.Context, database *db.DB, query string, args ...any) ([]string, error) {
	rows, err := database.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", query, err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// genConfig lists every dotted koanf key and the reference section that
// documents it. A key documented nowhere fails the run by name: the point of
// the index is that the configuration surface and its reference cannot drift
// apart silently, and a row saying "undocumented" would just record the drift.
func genConfig(w io.Writer) error {
	raw, err := os.ReadFile(configDoc)
	if err != nil {
		return err
	}
	sections := docSections(string(raw))
	keys := koanfKeys(reflect.TypeFor[config.Config](), "")
	slices.Sort(keys)

	var missing []string
	rows := make([][]string, 0, len(keys))
	for _, k := range keys {
		section, ok := sections[k]
		if !ok {
			missing = append(missing, k)
			continue
		}
		rows = append(rows, []string{code(k), section})
	}
	if len(missing) > 0 {
		return fmt.Errorf("%d config key(s) are documented nowhere under \"## Config Key Reference\" in %s — document them, then re-run:\n  %s",
			len(missing), configDoc, strings.Join(missing, "\n  "))
	}

	printf(w, "Generated from the `koanf` tags of `config.Config` by %s — do not edit by hand; `make docs-verify` fails when it drifts, and the tool exits non-zero when a key is documented nowhere above. %d keys.\n\n",
		code(regenCmd), len(rows))
	writeTable(w, []string{"Key", "Documented in"}, rows)
	return nil
}

// dottedKey matches a code span holding a dotted lower-case key, which is how
// the reference tables name a setting.
var dottedKey = regexp.MustCompile("`([a-z0-9_]+(?:\\.[a-z0-9_]+)+)`")

// docSections maps each config key named inside the "## Config Key Reference"
// section to the "### " heading it appears under. The scan stops at the next
// "## " heading, which is where the generated index itself lives — so the
// index can never be its own evidence that a key is documented.
func docSections(doc string) map[string]string {
	out := map[string]string{}
	inReference, heading := false, ""
	for line := range strings.Lines(doc) {
		line = strings.TrimRight(line, "\n")
		switch {
		case strings.HasPrefix(line, "## "):
			inReference = line == "## Config Key Reference"
			heading = ""
			continue
		case strings.HasPrefix(line, "### "):
			heading = strings.TrimPrefix(line, "### ")
			continue
		}
		if !inReference || heading == "" {
			continue
		}
		for _, m := range dottedKey.FindAllStringSubmatch(line, -1) {
			if _, seen := out[m[1]]; !seen {
				out[m[1]] = heading
			}
		}
	}
	return out
}

// koanfKeys returns every dotted koanf key reachable from t, recursing into
// nested structs the same way koanf unmarshals them. Copied from
// api/absence_contract_test.go, which walks the same surface for the same
// reason: config.Config's tags are the only enumeration of the keys, and
// config.defaults() is unexported.
func koanfKeys(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var keys []string
	for f := range t.Fields() {
		tag, ok := f.Tag.Lookup("koanf")
		if !ok || tag == "" || tag == "-" {
			continue
		}
		key := tag
		if prefix != "" {
			key = prefix + "." + tag
		}
		ft := f.Type
		for ft.Kind() == reflect.Ptr {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			keys = append(keys, koanfKeys(ft, key)...)
			continue
		}
		keys = append(keys, key)
	}
	return keys
}
