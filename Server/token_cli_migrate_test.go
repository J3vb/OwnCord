package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/migrations"
)

// tokenCLIDBFixture writes a config pointing at a database file in a temp dir, chdirs there so
// config.DefaultPath resolves to it, and returns the database path.
func tokenCLIDBFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "chatserver.db")
	body := "database:\n  path: " + filepath.ToSlash(dbPath) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	return dbPath
}

func migratedTo(t *testing.T, dbPath string, fsys fs.FS) {
	t.Helper()
	d, err := db.Open(dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer d.Close() //nolint:errcheck
	if fsys == nil {
		err = db.Migrate(d)
	} else {
		err = db.MigrateFS(d, fsys)
	}
	if err != nil {
		t.Fatalf("migrate: %v", err)
	}
}

func recordedVersions(t *testing.T, dbPath string) []string {
	t.Helper()
	d, err := db.OpenShared(dbPath)
	if err != nil {
		t.Fatalf("OpenShared: %v", err)
	}
	defer d.Close() //nolint:errcheck
	var joined string
	if err := d.SQLDb().QueryRow("SELECT COALESCE(group_concat(version, ','), '') FROM (SELECT version FROM schema_versions ORDER BY version)").Scan(&joined); err != nil {
		t.Fatalf("query: %v", err)
	}
	if joined == "" {
		return nil
	}
	return strings.Split(joined, ",")
}

func allButLastMigration(t *testing.T) fstest.MapFS {
	t.Helper()
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	out := fstest.MapFS{}
	for _, n := range names[:len(names)-1] {
		data, err := fs.ReadFile(migrations.FS, n)
		if err != nil {
			t.Fatal(err)
		}
		out[n] = &fstest.MapFile{Data: data}
	}
	return out
}

func TestTokenCLI_PendingMigrationsRefused(t *testing.T) {
	dbPath := tokenCLIDBFixture(t)
	migratedTo(t, dbPath, allButLastMigration(t))
	before := recordedVersions(t, dbPath)

	if code := runTokenCLI([]string{"list"}); code == 0 {
		t.Fatal("token list exited 0 against a database with pending migrations")
	}
	if after := recordedVersions(t, dbPath); !slices.Equal(before, after) {
		t.Fatalf("schema_versions changed: before %v, after %v", before, after)
	}
}

func TestTokenCLI_MigratedDatabaseWorks(t *testing.T) {
	dbPath := tokenCLIDBFixture(t)
	migratedTo(t, dbPath, nil)

	if code := runTokenCLI([]string{"list"}); code != 0 {
		t.Fatalf("token list exited %d on a fully migrated database", code)
	}
}

func TestTokenCLI_BrandNewDatabaseIsMigrated(t *testing.T) {
	dbPath := tokenCLIDBFixture(t)

	if code := runTokenCLI([]string{"list"}); code != 0 {
		t.Fatalf("token list exited %d on a brand-new database", code)
	}
	if len(recordedVersions(t, dbPath)) == 0 {
		t.Fatal("a brand-new database was not migrated")
	}
}
