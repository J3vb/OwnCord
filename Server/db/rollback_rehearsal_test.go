package db

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/rollback"
)

// The migration and rollback rehearsal the B4 exit gate's condition 7 asks
// for: alpha-shaped data migrates forward to HEAD and rolls back to where it
// started, through the reversal scripts an operator actually runs
// (Server/rollback). It is the drill protocol's shape — a copy of the
// committed snapshot, never the tracked file — and it is a test rather than a
// transcript so the next migration cannot land without one.
//
// The snapshot sits at 031, so the forward run is exactly the B4 delta and a
// full reversal has to land back on the snapshot's own schema. Three things
// are asserted, in this order:
//
//   - completeness — every migration the head applied past the snapshot's
//     level has a reversal, and every reversal names a migration that is
//     really there;
//   - the round trip — schema, applied-migration list, settings and row
//     counts all return to the snapshot's, which is what makes the reversals
//     exact rather than approximate;
//   - convergence — migrating forward again reaches the same head schema, so
//     a rolled-back database is one a server can start on.
//
// Two audit rows are seeded before the reversals run, because the snapshot
// carries no audit history and the 042/041 pair is the one place a reversal
// is documented to lose something. The checks below pin that loss to exactly
// the row it is documented for.

// collapseSpace makes the schema comparison whitespace-insensitive. SQLite
// rewrites a table's stored CREATE text when a column is added or dropped, so
// the text that comes back from a full round trip is semantically the original
// but not always byte-identical in its spacing.
var collapseSpace = regexp.MustCompile(`\s+`)

func schemaFingerprint(t *testing.T, d *DB) string {
	t.Helper()
	rows, err := d.writer.Query(
		`SELECT type, name, COALESCE(sql, '') FROM sqlite_master
		  WHERE name NOT LIKE 'sqlite_%'
		  ORDER BY type, name`)
	if err != nil {
		t.Fatalf("reading sqlite_master: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var out []string
	for rows.Next() {
		var typ, name, text string
		if err := rows.Scan(&typ, &name, &text); err != nil {
			t.Fatalf("scanning sqlite_master: %v", err)
		}
		out = append(out, typ+" "+name+" :: "+collapseSpace.ReplaceAllString(strings.TrimSpace(text), " "))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating sqlite_master: %v", err)
	}
	return strings.Join(out, "\n")
}

func appliedVersions(t *testing.T, d *DB) []string {
	t.Helper()
	rows, err := d.writer.Query(`SELECT version FROM schema_versions ORDER BY version`)
	if err != nil {
		t.Fatalf("reading schema_versions: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatalf("scanning schema_versions: %v", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating schema_versions: %v", err)
	}
	return out
}

func settingsMap(t *testing.T, d *DB) map[string]string {
	t.Helper()
	rows, err := d.writer.Query(`SELECT key, value FROM settings`)
	if err != nil {
		t.Fatalf("reading settings: %v", err)
	}
	defer func() { _ = rows.Close() }()

	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			t.Fatalf("scanning settings: %v", err)
		}
		out[k] = v
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterating settings: %v", err)
	}
	return out
}

// rehearsalCountedTables are the user-data classes the B4 delta must not
// touch on its way forward or back. audit_log is left out on purpose: the
// rehearsal seeds rows into it, and unlinking never deletes a row.
var rehearsalCountedTables = []string{
	"users", "channels", "messages", "attachments", "reactions", "invites", "sessions",
}

func classCounts(t *testing.T, d *DB) map[string]int {
	t.Helper()
	out := map[string]int{}
	for _, table := range rehearsalCountedTables {
		var n int
		//nolint:gosec // table names come from the constant list above.
		if err := d.writer.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&n); err != nil {
			t.Fatalf("counting %s: %v", table, err)
		}
		out[table] = n
	}
	return out
}

// applyReversal runs one reversal the way applyMigration runs a migration:
// the same statement splitter, one transaction for the whole file. It returns
// the statement count so the rehearsal's log names it.
func applyReversal(t *testing.T, d *DB, name, raw string) int {
	t.Helper()
	stmts := splitStatements(raw)
	tx, err := d.writer.Begin()
	if err != nil {
		t.Fatalf("begin tx for %s: %v", name, err)
	}
	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			_ = tx.Rollback()
			t.Fatalf("executing reversal %s: %v\nstatement: %s", name, err, stmt)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit reversal %s: %v", name, err)
	}
	return len(stmts)
}

// seedAuditTokenRows writes the two shapes the 042 reversal has to tell
// apart: a row holding only an erased actor's token, and a row holding a
// token for each of two erased principals.
func seedAuditTokenRows(t *testing.T, d *DB) {
	t.Helper()
	if _, err := d.writer.Exec(
		`INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, created_at, actor_token, subject_token)
		 VALUES (0, 'account_deleted', 'user', 5, '', '2026-09-03T00:00:00Z', 'actor-only-token', NULL),
		        (0, 'member_ban', 'user', 0, '', '2026-09-03T00:00:00Z', 'both-actor-token', 'both-target-token')`,
	); err != nil {
		t.Fatalf("seeding audit rows: %v", err)
	}
}

func checkActorTokensMovedBack(t *testing.T, d *DB) {
	t.Helper()

	// The actor-only row's token is back where migration 038 kept it, so
	// dropping actor_token next cannot be what loses it.
	var subject string
	if err := d.writer.QueryRow(
		`SELECT COALESCE(subject_token, '') FROM audit_log WHERE action = 'account_deleted'`,
	).Scan(&subject); err != nil {
		t.Fatalf("reading the actor-only row: %v", err)
	}
	if subject != "actor-only-token" {
		t.Fatalf("the 042 reversal left subject_token = %q, want the actor's token moved back", subject)
	}

	// The two-principal row keeps the target's token. The actor's is
	// forfeited by the next reversal, which is the documented loss and the
	// reason migration 041 exists.
	var both string
	if err := d.writer.QueryRow(
		`SELECT COALESCE(subject_token, '') FROM audit_log WHERE action = 'member_ban'`,
	).Scan(&both); err != nil {
		t.Fatalf("reading the two-principal row: %v", err)
	}
	if both != "both-target-token" {
		t.Fatalf("the 042 reversal changed a two-principal row's subject_token to %q, want the target's kept", both)
	}
}

func checkActorTokenColumnGone(t *testing.T, d *DB) {
	t.Helper()
	if _, err := d.writer.Exec(`SELECT actor_token FROM audit_log`); err == nil {
		t.Fatal("actor_token still selectable after the 041 reversal")
	}
	var n int
	if err := d.writer.QueryRow(`SELECT COUNT(*) FROM audit_log`).Scan(&n); err != nil {
		t.Fatalf("counting audit rows: %v", err)
	}
	if n != 2 {
		t.Fatalf("audit_log holds %d rows after the 041 reversal, want the 2 seeded — unlinking never deletes rows", n)
	}
}

func TestMigrationRollbackRehearsalOnAlphaSnapshot(t *testing.T) {
	database := openSnapshotCopy(t)

	baseSchema := schemaFingerprint(t, database)
	baseVersions := appliedVersions(t, database)
	baseSettings := settingsMap(t, database)
	baseCounts := classCounts(t, database)
	if len(baseVersions) != alphaSnapshotMigrations {
		t.Fatalf("snapshot carries %d applied migrations, want %d", len(baseVersions), alphaSnapshotMigrations)
	}

	if err := Migrate(database); err != nil {
		t.Fatalf("migrating the snapshot copy to HEAD: %v", err)
	}
	headSchema := schemaFingerprint(t, database)
	headVersions := appliedVersions(t, database)
	t.Logf("forward: %d migrations applied, %d -> %d", len(headVersions)-len(baseVersions), len(baseVersions), len(headVersions))

	// Completeness, both directions.
	for _, reversal := range rollback.Order {
		if migration := rollback.Migration(reversal); !slices.Contains(headVersions, migration) {
			t.Errorf("%s reverses %s, which HEAD never applied", reversal, migration)
		}
	}
	for _, migration := range headVersions {
		if slices.Contains(baseVersions, migration) {
			continue
		}
		reversed := slices.ContainsFunc(rollback.Order, func(reversal string) bool {
			return rollback.Migration(reversal) == migration
		})
		if !reversed {
			t.Errorf("migration %s has no reversal in Server/rollback — condition 7 needs one", migration)
		}
	}
	if t.Failed() {
		t.FailNow()
	}

	seedAuditTokenRows(t, database)

	postChecks := map[string]func(*testing.T, *DB){
		"042_audit_actor_token_backfill.down.sql": checkActorTokensMovedBack,
		"041_audit_actor_token.down.sql":          checkActorTokenColumnGone,
	}
	for _, reversal := range rollback.Order {
		raw, err := rollback.FS.ReadFile(reversal)
		if err != nil {
			t.Fatalf("reading %s: %v", reversal, err)
		}
		n := applyReversal(t, database, reversal, string(raw))
		t.Logf("reversed %-45s %d statements", reversal, n)
		if check := postChecks[reversal]; check != nil {
			check(t, database)
		}
	}

	// The round trip.
	if got := schemaFingerprint(t, database); got != baseSchema {
		t.Errorf("schema after the full rollback differs from the snapshot's:\n%s", firstSchemaDiff(baseSchema, got))
	}
	if got := appliedVersions(t, database); !slices.Equal(got, baseVersions) {
		t.Errorf("schema_versions after the full rollback holds %d rows, want the snapshot's %d — a reversal did not clear its own row", len(got), len(baseVersions))
	}
	if got := settingsMap(t, database); !mapsEqual(got, baseSettings) {
		t.Errorf("settings after the full rollback = %v, want the snapshot's %v", got, baseSettings)
	}
	if got := classCounts(t, database); !mapsEqual(got, baseCounts) {
		t.Errorf("row counts after the full rollback = %v, want the snapshot's %v", got, baseCounts)
	}

	// Convergence: a rolled-back database is one a server can start on.
	if err := Migrate(database); err != nil {
		t.Fatalf("re-migrating the rolled-back copy: %v", err)
	}
	if got := schemaFingerprint(t, database); got != headSchema {
		t.Errorf("re-migrating forward did not reach the same head schema:\n%s", firstSchemaDiff(headSchema, got))
	}
	if got := appliedVersions(t, database); !slices.Equal(got, headVersions) {
		t.Errorf("re-migrating forward applied %d migrations, want %d", len(got), len(headVersions))
	}
}

func mapsEqual[V comparable](a, b map[string]V) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if other, ok := b[k]; !ok || other != v {
			return false
		}
	}
	return true
}

// firstSchemaDiff names the first line the two fingerprints disagree on, so a
// failure points at the object rather than printing two whole schemas.
func firstSchemaDiff(want, got string) string {
	wantLines, gotLines := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := range max(len(wantLines), len(gotLines)) {
		var w, g string
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if w != g {
			return "want: " + w + "\ngot:  " + g
		}
	}
	return "(no line differs)"
}

// TestMarkerFileRollback reverses the deletion-marker file's schema and
// checks the server rebuilds it on the next open — the marker file is applied
// by OpenMarkerStore, not by a migration, so its reversal is separate.
func TestMarkerFileRollback(t *testing.T) {
	path := t.TempDir() + "/markers.sqlite"
	key := []byte("rehearsal-marker-key-32-bytes!!!")

	store, err := OpenMarkerStore(path, key)
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	token, _, err := store.RecordPendingAccount(context.Background(), 7, 7)
	if err != nil {
		t.Fatalf("recording a marker: %v", err)
	}
	if err := store.ConfirmAccount(context.Background(), token); err != nil {
		t.Fatalf("confirming the marker: %v", err)
	}
	if has, err := store.HasAccountMarkers(context.Background()); err != nil || !has {
		t.Fatalf("HasAccountMarkers before the rollback = %v, %v — want true", has, err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("closing the marker store: %v", err)
	}

	markerDB, err := Open(path)
	if err != nil {
		t.Fatalf("opening the marker file: %v", err)
	}
	raw, err := rollback.FS.ReadFile(rollback.MarkerFile)
	if err != nil {
		t.Fatalf("reading %s: %v", rollback.MarkerFile, err)
	}
	before := schemaFingerprint(t, markerDB)
	for _, table := range []string{"deletion_markers", "sequence_floors", "floor_probes"} {
		if !strings.Contains(before, table) {
			t.Fatalf("the marker file has no %s table to reverse — the reversal is stale", table)
		}
	}
	applyReversal(t, markerDB, rollback.MarkerFile, string(raw))
	if after := schemaFingerprint(t, markerDB); strings.TrimSpace(after) != "" {
		t.Errorf("the marker reversal left objects behind:\n%s", after)
	}
	if err := markerDB.Close(); err != nil {
		t.Fatalf("closing the marker file: %v", err)
	}

	// The server rebuilds the schema on the next open, and the marker the
	// rollback discarded is gone — which is the forfeited guarantee the
	// reversal's own comment warns about.
	reopened, err := OpenMarkerStore(path, key)
	if err != nil {
		t.Fatalf("reopening the marker store after the rollback: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	has, err := reopened.HasAccountMarkers(context.Background())
	if err != nil {
		t.Fatalf("HasAccountMarkers: %v", err)
	}
	if has {
		t.Error("a marker survived the marker-file rollback")
	}
}

// TestReversalFilesAreOperatorSafe pins the two properties the documented
// operator command depends on (Server/rollback/README.md, "Running one").
//
// An operator runs a reversal by piping it to the sqlite3 CLI wrapped in
// BEGIN/COMMIT, because the CLI otherwise commits each statement as it reads
// it. That wrapping is only valid while no reversal carries transaction
// control of its own, and the wrap is only worth having while the
// schema_versions delete is last: -bail stops at the first error, and a file
// that cleared its tracker row before its schema change would leave the next
// start re-applying the migration onto a half-reversed schema.
//
// applyReversal above runs each file in one transaction, which is the same
// shape, so the rehearsal exercises the path the README documents.
// sqlText drops the -- comment lines a statement carries, so the checks below
// read the SQL rather than the prose explaining it.
func sqlText(stmt string) string {
	var kept []string
	for line := range strings.SplitSeq(stmt, "\n") {
		if code, _, found := strings.Cut(line, "--"); found {
			line = code
		}
		if strings.TrimSpace(line) != "" {
			kept = append(kept, line)
		}
	}
	return collapseSpace.ReplaceAllString(strings.TrimSpace(strings.Join(kept, " ")), " ")
}

func TestReversalFilesAreOperatorSafe(t *testing.T) {
	txnControl := []string{"begin", "commit", "rollback", "savepoint", "release", "end"}

	for _, name := range append(slices.Clone(rollback.Order), rollback.MarkerFile) {
		raw, err := rollback.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		stmts := splitStatements(string(raw))
		if len(stmts) == 0 {
			t.Errorf("%s has no statements", name)
			continue
		}

		code := make([]string, 0, len(stmts))
		for _, stmt := range stmts {
			code = append(code, sqlText(stmt))
		}

		for _, stmt := range code {
			first, _, _ := strings.Cut(strings.ToLower(stmt), " ")
			if slices.Contains(txnControl, strings.TrimSuffix(first, ";")) {
				t.Errorf("%s carries its own transaction control (%q) — the operator wraps the file in one", name, first)
			}
		}

		if name == rollback.MarkerFile {
			// The marker file is not a migration and has no tracker row.
			for _, stmt := range code {
				if strings.Contains(stmt, "schema_versions") {
					t.Errorf("%s touches schema_versions, but the marker file is not a migration", name)
				}
			}
			continue
		}

		want := "DELETE FROM schema_versions WHERE version = '" + rollback.Migration(name) + "'"
		if last := code[len(code)-1]; last != want {
			t.Errorf("%s ends with %q, want %q as its last statement", name, last, want)
		}
		for _, stmt := range code[:len(code)-1] {
			if strings.Contains(stmt, "schema_versions") {
				t.Errorf("%s touches schema_versions before its last statement: %q", name, stmt)
			}
		}
	}
}
