package db

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
)

func openEmptyMemory(t *testing.T) *DB {
	t.Helper()
	d, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// migratedFingerprint lists every schema object, every applied migration and the
// row count of every table, which is what a migrated database is made of.
func migratedFingerprint(t *testing.T, d *DB) []string {
	t.Helper()
	var out []string
	rows, err := d.writer.Query("SELECT type, name, tbl_name, COALESCE(sql, '') FROM sqlite_master ORDER BY type, name")
	if err != nil {
		t.Fatalf("read sqlite_master: %v", err)
	}
	var tables []string
	for rows.Next() {
		var typ, name, tbl, sql string
		if err := rows.Scan(&typ, &name, &tbl, &sql); err != nil {
			t.Fatalf("scan sqlite_master: %v", err)
		}
		out = append(out, strings.Join([]string{typ, name, tbl, sql}, "|"))
		if typ == "table" && !strings.HasPrefix(name, "sqlite_") {
			tables = append(tables, name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate sqlite_master: %v", err)
	}
	_ = rows.Close()
	for _, table := range tables {
		var n int
		if err := d.writer.QueryRow(fmt.Sprintf("SELECT count(*) FROM %q", table)).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}
		out = append(out, fmt.Sprintf("rows %s=%d", table, n))
	}
	vrows, err := d.writer.Query("SELECT version FROM schema_versions ORDER BY version")
	if err != nil {
		t.Fatalf("read schema_versions: %v", err)
	}
	defer func() { _ = vrows.Close() }()
	for vrows.Next() {
		var v string
		if err := vrows.Scan(&v); err != nil {
			t.Fatalf("scan schema_versions: %v", err)
		}
		out = append(out, "version "+v)
	}
	return out
}

func TestMigrate_FreshMemoryCopyMatchesRunningEveryMigration(t *testing.T) {
	slow := openEmptyMemory(t)
	if err := migrateEmbedded(slow); err != nil {
		t.Fatalf("migrateEmbedded: %v", err)
	}
	fast := openEmptyMemory(t)
	if !restoreFreshMemory(fast) {
		t.Fatal("an empty in-memory database was not given the migrated image")
	}
	if got, want := migratedFingerprint(t, fast), migratedFingerprint(t, slow); !slices.Equal(got, want) {
		t.Fatalf("copied database differs from a migrated one\ncopy: %v\nmigrated: %v", got, want)
	}
	for _, pragma := range []string{"foreign_keys", "busy_timeout", "synchronous", "temp_store", "cache_size", "journal_mode"} {
		var got, want string
		if err := fast.writer.QueryRow("PRAGMA " + pragma).Scan(&got); err != nil {
			t.Fatalf("PRAGMA %s on the copy: %v", pragma, err)
		}
		if err := slow.writer.QueryRow("PRAGMA " + pragma).Scan(&want); err != nil {
			t.Fatalf("PRAGMA %s on the migrated database: %v", pragma, err)
		}
		if got != want {
			t.Errorf("PRAGMA %s = %s on the copy, %s on a migrated database", pragma, got, want)
		}
	}
	for _, query := range []string{
		"SELECT group_concat(id || ':' || name || ':' || permissions, ',') FROM (SELECT * FROM roles ORDER BY id)",
		"SELECT group_concat(key || '=' || value, ',') FROM (SELECT * FROM settings ORDER BY key)",
	} {
		var got, want string
		if err := fast.writer.QueryRow(query).Scan(&got); err != nil {
			t.Fatalf("%s on the copy: %v", query, err)
		}
		if err := slow.writer.QueryRow(query).Scan(&want); err != nil {
			t.Fatalf("%s on the migrated database: %v", query, err)
		}
		if got != want {
			t.Errorf("seeded rows differ\ncopy: %s\nmigrated: %s", got, want)
		}
	}
	// A second Migrate on the copy finds nothing to apply, as on a migrated one.
	if err := Migrate(fast); err != nil {
		t.Fatalf("Migrate on the copy: %v", err)
	}
}

func TestMigrate_FreshMemoryCopiesAreIndependent(t *testing.T) {
	// Both are filled from the same image at once, which also covers the
	// first callers racing to build it.
	dbs := []*DB{openEmptyMemory(t), openEmptyMemory(t), openEmptyMemory(t), openEmptyMemory(t)}
	restored := make([]bool, len(dbs))
	var wg sync.WaitGroup
	for i, d := range dbs {
		wg.Go(func() { restored[i] = restoreFreshMemory(d) })
	}
	wg.Wait()
	for i, ok := range restored {
		if !ok {
			t.Fatalf("database %d was not given the migrated image", i)
		}
	}
	a, b := dbs[0], dbs[1]
	if _, err := a.writer.Exec("INSERT INTO settings (key, value) VALUES ('migrate_memory_probe', 'a')"); err != nil {
		t.Fatalf("write to a: %v", err)
	}
	var n int
	if err := b.writer.QueryRow("SELECT count(*) FROM settings WHERE key = 'migrate_memory_probe'").Scan(&n); err != nil {
		t.Fatalf("read b: %v", err)
	}
	if n != 0 {
		t.Fatal("a write to one copied database showed up in another")
	}
}

func TestMigrate_SharedCacheMemoryRunsTheMigrations(t *testing.T) {
	d, err := Open("file:migrate_memory_shared?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if restoreFreshMemory(d) {
		t.Fatal("a shared-cache memory database was given the image")
	}
}

func TestMigrate_NonEmptyMemoryRunsTheMigrations(t *testing.T) {
	d := openEmptyMemory(t)
	if _, err := d.writer.Exec("CREATE TABLE preexisting (id INTEGER)"); err != nil {
		t.Fatalf("create table: %v", err)
	}
	if restoreFreshMemory(d) {
		t.Fatal("a non-empty database was overwritten with the image")
	}
	if err := Migrate(d); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	var n int
	if err := d.writer.QueryRow("SELECT count(*) FROM sqlite_master WHERE name = 'preexisting'").Scan(&n); err != nil || n != 1 {
		t.Fatalf("the pre-existing table was lost (count %d, err %v)", n, err)
	}
}
