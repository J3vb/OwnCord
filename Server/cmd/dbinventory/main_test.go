package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/invariants"
)

// TestProductionFilesExemptsOnlyTopLevelLayers pins the walker's exemption to
// the root-relative path: Server/db and Server/service are the layers that
// may import db; a nested directory that shares a name (api/service/) is
// production code above the domain layer and must be inventoried. Tests,
// testdata and hidden directories are skipped at any depth.
func TestProductionFilesExemptsOnlyTopLevelLayers(t *testing.T) {
	root := t.TempDir()
	for _, p := range []string{
		"api/w.go",
		"api/w_test.go",
		"api/service/x.go",
		"api/db/y.go",
		"service/y.go",
		"db/z.go",
		"db/dbgen/q.go",
		"ws/testdata/fixture.go",
		".hidden/h.go",
		"main.go",
	} {
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("package x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := productionFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api/db/y.go", "api/service/x.go", "api/w.go", "main.go"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("productionFiles = %v, want %v", got, want)
	}
}

// TestInventorySeesUseWithoutImport is B6-14's measurement, in miniature: the
// handle sits on a package field, so a file that never imports db can still
// call it and hand it on. Before B6-14 the walk skipped every file whose db
// alias was empty, and all three rows below except the declaring one were
// invisible to both gates.
func TestInventorySeesUseWithoutImport(t *testing.T) {
	root := t.TempDir()
	write := func(p, src string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const importDB = "import \"github.com/J3vb/OwnCord/Server/db\"\n"
	write("db/db.go", "package db\n\ntype DB struct{}\n")
	write("ws/hub.go", "package ws\n"+importDB+"\ntype Hub struct{ db *db.DB }\n")
	// No import, reaches the field: a call and a hand-off.
	write("ws/purge.go", "package ws\n\nfunc (h *Hub) purge() { h.db.DeleteEventsForUser() }\n")
	write("ws/wire.go", "package ws\nimport \"x/svc\"\n\nfunc (h *Hub) wire() { svc.New(h.db) }\n")
	// No import, no use: not a row. Threading a parameter on inside the same
	// package is not a hand-off either.
	write("ws/quiet.go", "package ws\n\nfunc quiet(n int) int { return n }\n")
	write("ws/thread.go", "package ws\n"+importDB+"\nfunc a(d *db.DB) { b(d) }\nfunc b(d *db.DB) {}\n")
	// No import: the handle is read out of its carrier and assigned into one
	// this file cannot type — the shape that gives the handle to an interface
	// field without naming it in a call or a literal.
	write("ws/attach.go", "package ws\n\ntype carrier struct{ Store any }\n\n"+
		"func (h *Hub) attach(c *carrier) { c.Store = h.db }\n")

	rows, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]fileUse{}
	for _, r := range rows {
		got[r.rel] = r
	}
	for _, rel := range []string{"ws/quiet.go"} {
		if _, listed := got[rel]; listed {
			t.Errorf("%s uses nothing and must not be a row", rel)
		}
	}
	purge, ok := got["ws/purge.go"]
	if !ok {
		t.Fatalf("ws/purge.go calls the handle through Hub.db and must be a row; rows: %v", rows)
	}
	if purge.imports {
		t.Error("ws/purge.go does not import db; the row must say so")
	}
	if !reflect.DeepEqual(purge.methods, map[string]int{"DeleteEventsForUser": 1}) {
		t.Errorf("ws/purge.go calls = %v", purge.methods)
	}
	wire, ok := got["ws/wire.go"]
	if !ok {
		t.Fatalf("ws/wire.go hands the handle to another package and must be a row; rows: %v", rows)
	}
	if !reflect.DeepEqual(wire.hands, map[string]int{"svc.New": 1}) {
		t.Errorf("ws/wire.go hands = %v", wire.hands)
	}
	if thread := got["ws/thread.go"]; len(thread.hands) != 0 {
		t.Errorf("threading a *db.DB parameter inside one package is not a hand-off; got %v", thread.hands)
	}
	// Giving the handle to a field this file cannot type is a hand-off even
	// though no callee receives it: the handle has left its carrier.
	attach, ok := got["ws/attach.go"]
	if !ok {
		t.Fatalf("ws/attach.go assigns the handle into another carrier and must be a row; rows: %v", rows)
	}
	if !reflect.DeepEqual(attach.hands, map[string]int{"c.Store": 1}) {
		t.Errorf("ws/attach.go hands = %v, want c.Store×1", attach.hands)
	}
}

// TestInventoryFollowsPackageConstructor is the other half of "use, not
// import": internal/app opens the handle through a package-level constructor
// (`database, err := openDatabase(cfg)`), not through db.Open* directly, so
// without the package's constructor set the local is not a *db.DB to the
// walker and every call on it — database.Close() among them — measures as no
// call at all. The db package's own functions are never hand-offs, whether the
// argument is a local or a field read.
func TestInventoryFollowsPackageConstructor(t *testing.T) {
	root := t.TempDir()
	write := func(p, src string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const importDB = "import \"github.com/J3vb/OwnCord/Server/db\"\n"
	write("db/db.go", "package db\n\ntype DB struct{}\n")
	write("app/open.go", "package app\n"+importDB+
		"\ntype App struct{ database *db.DB }\n\nfunc openDatabase() (*db.DB, error) { return nil, nil }\n")
	// No import of its own: the handle arrives from the package's constructor,
	// is stored on the field, and is closed and handed on from there.
	write("app/start.go", "package app\nimport \"x/svc\"\n\n"+
		"func (a *App) start() {\n\tdatabase, _ := openDatabase()\n\ta.database = database\n"+
		"\tsvc.New(database)\n\tdatabase.Close()\n}\n")
	// A callee in db itself is the handle's own package, not an owner —
	// including when the argument is read straight out of the field.
	write("app/migrate.go", "package app\n"+importDB+
		"\nfunc (a *App) migrate() { _ = db.Migrate(a.database) }\n")

	rows, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]fileUse{}
	for _, r := range rows {
		got[r.rel] = r
	}
	start, ok := got["app/start.go"]
	if !ok {
		t.Fatalf("app/start.go closes and hands on the handle and must be a row; rows: %v", rows)
	}
	if !reflect.DeepEqual(start.methods, map[string]int{"Close": 1}) {
		t.Errorf("app/start.go calls = %v, want Close×1", start.methods)
	}
	if !reflect.DeepEqual(start.hands, map[string]int{"svc.New": 1}) {
		t.Errorf("app/start.go hands = %v, want svc.New×1", start.hands)
	}
	if migrate := got["app/migrate.go"]; len(migrate.hands) != 0 {
		t.Errorf("a db-package callee is not a hand-off; got %v", migrate.hands)
	}
}

// TestInventoryBindsConstructorResultsByPosition is the positional half of the
// constructor rule: results bind to the names on the left by their order in the
// signature, so a constructor that returns its handle second must put the
// handle in the second name. Binding the call rather than the result would
// attach the handle to the error instead — a phantom *db.DB named `err`, whose
// method calls measure as handle calls, while the real handle goes unmeasured
// and its file never becomes a row.
func TestInventoryBindsConstructorResultsByPosition(t *testing.T) {
	root := t.TempDir()
	write := func(p, src string) {
		t.Helper()
		full := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const importDB = "import \"github.com/J3vb/OwnCord/Server/db\"\n"
	write("db/db.go", "package db\n\ntype DB struct{}\n")
	write("app/open.go", "package app\n"+importDB+
		"\nfunc reopen() (error, *db.DB) { return nil, nil }\n")
	// No import of its own: the handle arrives second and is handed on from
	// there. err.Error() is not a handle call and svc.New(database) is a
	// hand-off.
	write("app/resume.go", "package app\nimport \"x/svc\"\n\n"+
		"func resume() {\n\terr, database := reopen()\n\tif err != nil {\n\t\t_ = err.Error()\n\t}\n\tsvc.New(database)\n}\n")

	rows, err := inventory(root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]fileUse{}
	for _, r := range rows {
		got[r.rel] = r
	}
	resume, ok := got["app/resume.go"]
	if !ok {
		t.Fatalf("app/resume.go hands on the handle and must be a row; rows: %v", rows)
	}
	if !reflect.DeepEqual(resume.hands, map[string]int{"svc.New": 1}) {
		t.Errorf("app/resume.go hands = %v, want svc.New×1", resume.hands)
	}
	if len(resume.methods) != 0 {
		t.Errorf("the error result is not the handle, so it makes no handle call; got %v", resume.methods)
	}
}

// TestPrintTableProblemClasses drives each class printTable can report from a
// fixture allowlist, so a regression shows up here rather than as a whole-tree
// failure nobody can localise.
func TestPrintTableProblemClasses(t *testing.T) {
	allow := map[string]invariants.DBImportEntry{
		"api/adapter.go":  {Disposition: "adapter", Note: "types only"},
		"app/pinned.go":   {Disposition: "boundary", Note: "owns it", Calls: map[string]int{"Close": 1}, Hands: map[string]int{"svc.New": 1}},
		"app/drifted.go":  {Disposition: "boundary", Note: "owns it", Calls: map[string]int{"Close": 1}},
		"app/handed.go":   {Disposition: "boundary", Note: "owns it", Hands: map[string]int{"svc.New": 1}},
		"app/vanished.go": {Disposition: "boundary", Note: "gone from the tree"},
	}
	row := func(rel string, imports bool, methods, hands map[string]int) fileUse {
		return fileUse{
			rel: rel, imports: imports,
			types: map[string]int{}, funcs: map[string]int{}, values: map[string]int{},
			methods: methods, hands: hands,
		}
	}
	none := map[string]int{}
	rows := []fileUse{
		row("api/adapter.go", true, map[string]int{"GetUserByID": 1}, none),            // adapter makes a call
		row("api/other.go", true, none, none),                                          // unlisted importer
		row("app/drifted.go", true, map[string]int{"Close": 2}, none),                  // calls drifted
		row("app/handed.go", true, none, map[string]int{"svc.New": 1, "svc.Other": 1}), // hands drifted
		row("app/pinned.go", true, map[string]int{"Close": 1}, map[string]int{"svc.New": 1}),
		row("ws/field.go", false, map[string]int{"GetReport": 1}, none), // unlisted by use
	}

	var buf bytes.Buffer
	problems := printTable(&buf, rows, allow)
	out := buf.String()
	for _, want := range []string{
		"ADAPTER ROW USES THE HANDLE: `api/adapter.go`",
		"UNLISTED importer (no allowlist row): `api/other.go`",
		"CALLS DRIFTED: `app/drifted.go` calls `Close×2`; the row pins `Close`",
		"HANDS DRIFTED: `app/handed.go`",
		"UNLISTED BY USE (no import, no allowlist row): `ws/field.go`",
		"STALE allowlist row (file no longer uses db): `app/vanished.go`",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing problem line %q in:\n%s", want, out)
		}
	}
	if problems != 6 {
		t.Errorf("problems = %d, want 6:\n%s", problems, out)
	}
	if strings.Contains(out, "`app/pinned.go` calls") || strings.Contains(out, "`app/pinned.go` hands") {
		t.Errorf("a row whose pins match what it measures is not a problem:\n%s", out)
	}
	// The one row that reaches the handle without importing it must be counted
	// as such in the summary the document quotes.
	if !strings.Contains(out, "5 import it, 1 use the handle without importing it;") {
		t.Errorf("the summary line must split imports from field use:\n%s", out)
	}
}
