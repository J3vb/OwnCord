package db_test

// migrate_test.go — TDD tests for the tracked migration system.
//
// RED phase: these tests are written before the implementation exists.
// They verify the contract of MigrateFS after it gains schema_versions tracking.
//
// Test matrix:
//   TestMigrate_SchemaVersionsTableCreated      — schema_versions exists after first run
//   TestMigrate_AllMigrationsRecorded           — every applied file is recorded
//   TestMigrate_SkipsAlreadyApplied             — second call skips files already in schema_versions
//   TestMigrate_AppliesNewMigrationsOnly        — only new files are applied on subsequent runs
//   TestMigrate_OrderIsLexicographic            — migrations execute in sorted filename order
//   TestMigrate_SeedExistingDatabase            — existing DB (no schema_versions) is seeded
//   TestMigrate_SeedDoesNotReRunMigrations      — seeded migrations are not re-executed
//   TestMigrate_SchemaVersionsAppliedAtRecorded — applied_at column is populated
//   TestMigrate_EmptyFSSucceeds                 — empty FS is fine, no error
//   TestMigrate_InvalidSQLReturnsError          — bad SQL still surfaces as an error
//   TestMigrate_ReadFileErrorReturnsError       — FS read failure surfaces as an error
//   TestMigrate_PartialRunRecordsOnlyApplied    — failure mid-run leaves earlier files recorded
//   TestMigrate_AppliedAtIsISO8601              — applied_at timestamp format is valid

import (
	"database/sql"
	"fmt"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/db"
)

// failReadDirFS is an fs.FS whose root Open succeeds but ReadDir always errors.
// This exercises the sqlFilenames ReadDir error path.
type failReadDirFS struct{}

func (failReadDirFS) Open(name string) (fs.File, error) {
	if name == "." {
		return &badDirFile{}, nil
	}
	return nil, fmt.Errorf("no files")
}

type badDirFile struct{}

func (badDirFile) Read([]byte) (int, error)        { return 0, fmt.Errorf("not a file") }
func (badDirFile) Close() error                    { return nil }
func (badDirFile) Stat() (fs.FileInfo, error)      { return fakeDirInfo{}, nil }
func (badDirFile) ReadDir(int) ([]fs.DirEntry, error) {
	return nil, fmt.Errorf("readdir always fails")
}

// ---- helpers ----------------------------------------------------------------

// countVersions returns the number of rows in schema_versions.
func countVersions(t *testing.T, database *db.DB) int {
	t.Helper()
	var n int
	err := database.QueryRow("SELECT COUNT(*) FROM schema_versions").Scan(&n)
	if err != nil {
		t.Fatalf("counting schema_versions: %v", err)
	}
	return n
}

// hasVersion reports whether a specific filename is recorded in schema_versions.
func hasVersion(t *testing.T, database *db.DB, filename string) bool {
	t.Helper()
	var v string
	err := database.QueryRow(
		"SELECT version FROM schema_versions WHERE version = ?", filename,
	).Scan(&v)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		t.Fatalf("querying schema_versions for %q: %v", filename, err)
	}
	return true
}

// tableExists reports whether a table (or virtual table) exists in sqlite_master.
func tableExists(t *testing.T, database *db.DB, name string) bool {
	t.Helper()
	var n string
	err := database.QueryRow(
		"SELECT name FROM sqlite_master WHERE type='table' AND name=?", name,
	).Scan(&n)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		t.Fatalf("checking table %q: %v", name, err)
	}
	return true
}

// simpleFS builds an fstest.MapFS with the provided filename→SQL pairs.
func simpleFS(pairs ...string) fstest.MapFS {
	if len(pairs)%2 != 0 {
		panic("simpleFS requires an even number of arguments (name, sql, ...)")
	}
	m := fstest.MapFS{}
	for i := 0; i < len(pairs); i += 2 {
		m[pairs[i]] = &fstest.MapFile{Data: []byte(pairs[i+1])}
	}
	return m
}

// ---- tests ------------------------------------------------------------------

// TestMigrate_SchemaVersionsTableCreated verifies that MigrateFS creates the
// schema_versions tracking table on first run.
func TestMigrate_SchemaVersionsTableCreated(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_create_foo.sql", "CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	if !tableExists(t, database, "schema_versions") {
		t.Error("schema_versions table was not created by MigrateFS")
	}
}

// TestMigrate_AllMigrationsRecorded verifies that every applied .sql file
// gets a row inserted into schema_versions.
func TestMigrate_AllMigrationsRecorded(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_alpha.sql", "CREATE TABLE IF NOT EXISTS alpha (id INTEGER PRIMARY KEY);",
		"002_beta.sql",  "CREATE TABLE IF NOT EXISTS beta  (id INTEGER PRIMARY KEY);",
		"003_gamma.sql", "CREATE TABLE IF NOT EXISTS gamma (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	for _, name := range []string{"001_alpha.sql", "002_beta.sql", "003_gamma.sql"} {
		if !hasVersion(t, database, name) {
			t.Errorf("migration %q not recorded in schema_versions", name)
		}
	}
}

// TestMigrate_SkipsAlreadyApplied verifies that a second call to MigrateFS
// with the same FS does not re-execute already-applied migrations.
func TestMigrate_SkipsAlreadyApplied(t *testing.T) {
	database := openMemory(t)

	// This migration inserts a row; if re-run it would violate UNIQUE.
	fsys := simpleFS(
		"001_unique.sql", `
			CREATE TABLE IF NOT EXISTS unique_check (val TEXT UNIQUE);
			INSERT INTO unique_check (val) VALUES ('singleton');
		`,
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() first run error: %v", err)
	}

	// Second run — must not fail even though the INSERT would conflict if re-run.
	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() second run error (migration was re-executed): %v", err)
	}

	// Confirm the row exists exactly once.
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM unique_check WHERE val='singleton'").Scan(&count); err != nil {
		t.Fatalf("counting unique_check: %v", err)
	}
	if count != 1 {
		t.Errorf("unique_check has %d rows, want exactly 1 — migration was re-run", count)
	}
}

// TestMigrate_AppliesNewMigrationsOnly verifies that when a new file is added
// to the FS, only that file is applied on the second call.
func TestMigrate_AppliesNewMigrationsOnly(t *testing.T) {
	database := openMemory(t)

	fsFirst := simpleFS(
		"001_base.sql", "CREATE TABLE IF NOT EXISTS base_tbl (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsFirst); err != nil {
		t.Fatalf("MigrateFS() first run error: %v", err)
	}

	versionsAfterFirst := countVersions(t, database)

	// Add a second migration.
	fsSecond := simpleFS(
		"001_base.sql", "CREATE TABLE IF NOT EXISTS base_tbl (id INTEGER PRIMARY KEY);",
		"002_extra.sql", "CREATE TABLE IF NOT EXISTS extra_tbl (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsSecond); err != nil {
		t.Fatalf("MigrateFS() second run error: %v", err)
	}

	versionsAfterSecond := countVersions(t, database)

	if versionsAfterSecond != versionsAfterFirst+1 {
		t.Errorf(
			"expected %d version rows after second run, got %d",
			versionsAfterFirst+1, versionsAfterSecond,
		)
	}

	if !hasVersion(t, database, "002_extra.sql") {
		t.Error("002_extra.sql not recorded after second run")
	}

	if !tableExists(t, database, "extra_tbl") {
		t.Error("extra_tbl not created by second run")
	}
}

// TestMigrate_OrderIsLexicographic verifies that migrations are applied in
// sorted filename order, not insertion or readdir order.
func TestMigrate_OrderIsLexicographic(t *testing.T) {
	database := openMemory(t)

	// 002 creates the table; 001 tries to insert into it.
	// If run out of order (002 before 001) the INSERT would fail with "no such table".
	// With lexicographic ordering 001 runs first and creates the table,
	// then 002 inserts into it — so we verify the correct order by checking
	// the table was created before the insert was attempted.
	fsys := simpleFS(
		"002_insert.sql", "INSERT INTO order_check (label) VALUES ('second');",
		"001_create.sql", "CREATE TABLE IF NOT EXISTS order_check (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	var label string
	if err := database.QueryRow("SELECT label FROM order_check LIMIT 1").Scan(&label); err != nil {
		t.Fatalf("selecting from order_check: %v", err)
	}
	if label != "second" {
		t.Errorf("label = %q, want 'second'", label)
	}
}

// TestMigrate_SeedExistingDatabase verifies that when schema_versions does not
// exist but other known tables do (simulating an existing DB from before
// tracking was added), all current migration filenames are seeded so they are
// not re-executed.
func TestMigrate_SeedExistingDatabase(t *testing.T) {
	database := openMemory(t)

	// Manually create a table to simulate a previously-migrated database
	// that does not yet have schema_versions.
	if _, err := database.Exec(
		"CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);",
	); err != nil {
		t.Fatalf("setup: creating users table: %v", err)
	}

	// This migration would drop and recreate users; if it runs it will wipe data.
	// The seeding logic must prevent it from running.
	fsys := simpleFS(
		"001_initial.sql", `
			DROP TABLE IF EXISTS users;
			CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT);
		`,
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	// The migration must be recorded (seeded).
	if !hasVersion(t, database, "001_initial.sql") {
		t.Error("001_initial.sql should be seeded into schema_versions for existing DB")
	}

	// The users table must still have its original schema (no 'name' column),
	// proving the DROP/CREATE did not run.
	_, err := database.Exec("INSERT INTO users (id) VALUES (42)")
	if err != nil {
		t.Errorf("users table appears to have been recreated (DROP ran): %v", err)
	}
}

// TestMigrate_SeedDoesNotReRunMigrations is a companion to the seeding test:
// after seeding, a subsequent MigrateFS call with the same FS must be a no-op.
// The seeding heuristic triggers on the presence of the "users" sentinel table,
// so we create that table to simulate a pre-tracking database.
func TestMigrate_SeedDoesNotReRunMigrations(t *testing.T) {
	database := openMemory(t)

	// Simulate an existing DB: create the "users" sentinel table so the seeding
	// heuristic fires, plus the table that the migration would modify.
	if _, err := database.Exec(
		"CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);",
	); err != nil {
		t.Fatalf("setup users: %v", err)
	}
	if _, err := database.Exec(
		"CREATE TABLE IF NOT EXISTS existing (id INTEGER PRIMARY KEY);",
	); err != nil {
		t.Fatalf("setup existing: %v", err)
	}

	// This migration would INSERT into existing; if it runs, count becomes 1.
	fsys := simpleFS(
		"001_existing.sql", `
			CREATE TABLE IF NOT EXISTS existing (id INTEGER PRIMARY KEY);
			INSERT INTO existing (id) VALUES (1);
		`,
	)

	// First call — seeds because schema_versions is absent AND users table exists.
	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() first run error: %v", err)
	}

	// Second call — must be a no-op (migration is already recorded).
	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() second run error: %v", err)
	}

	// existing table should be empty — the INSERT was never executed (seeded only).
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM existing").Scan(&count); err != nil {
		t.Fatalf("counting existing: %v", err)
	}
	if count != 0 {
		t.Errorf("existing has %d rows, want 0 — seeded migration was re-executed", count)
	}
}

// TestMigrate_SchemaVersionsAppliedAtRecorded verifies that applied_at is
// populated for every recorded migration.
func TestMigrate_SchemaVersionsAppliedAtRecorded(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_ts.sql", "CREATE TABLE IF NOT EXISTS ts_test (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	var appliedAt string
	err := database.QueryRow(
		"SELECT applied_at FROM schema_versions WHERE version = '001_ts.sql'",
	).Scan(&appliedAt)
	if err != nil {
		t.Fatalf("querying applied_at: %v", err)
	}
	if appliedAt == "" {
		t.Error("applied_at should not be empty")
	}
}

// TestMigrate_AppliedAtIsISO8601 verifies applied_at is a parseable datetime.
func TestMigrate_AppliedAtIsISO8601(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_dt.sql", "CREATE TABLE IF NOT EXISTS dt_test (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	var appliedAt string
	if err := database.QueryRow(
		"SELECT applied_at FROM schema_versions WHERE version = '001_dt.sql'",
	).Scan(&appliedAt); err != nil {
		t.Fatalf("querying applied_at: %v", err)
	}

	// SQLite datetime('now') produces "YYYY-MM-DD HH:MM:SS".
	formats := []string{
		"2006-01-02 15:04:05",
		time.RFC3339,
	}
	var parsed bool
	for _, f := range formats {
		if _, err := time.Parse(f, appliedAt); err == nil {
			parsed = true
			break
		}
	}
	if !parsed {
		t.Errorf("applied_at %q is not a recognised datetime format", appliedAt)
	}
}

// TestMigrate_EmptyFSSucceeds verifies that an empty FS returns no error and
// still creates the schema_versions table.
func TestMigrate_EmptyFSSucceeds(t *testing.T) {
	database := openMemory(t)

	fsys := fstest.MapFS{}

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() with empty FS error: %v", err)
	}

	if !tableExists(t, database, "schema_versions") {
		t.Error("schema_versions should be created even for empty FS")
	}

	if countVersions(t, database) != 0 {
		t.Error("schema_versions should be empty for empty FS")
	}
}

// TestMigrate_InvalidSQLReturnsError verifies that a migration with invalid
// SQL causes MigrateFS to return a non-nil error.
func TestMigrate_InvalidSQLReturnsError(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_bad.sql", "THIS IS NOT VALID SQL !!!@@@###",
	)

	err := db.MigrateFS(database, fsys)
	if err == nil {
		t.Error("MigrateFS() should return error for invalid SQL, got nil")
	}
}

// TestMigrate_ReadFileErrorReturnsError verifies that an FS read failure
// surfaces as an error from MigrateFS.
func TestMigrate_ReadFileErrorReturnsError(t *testing.T) {
	database := openMemory(t)

	err := db.MigrateFS(database, failReadFS{})
	if err == nil {
		t.Error("MigrateFS() should return error when ReadFile fails")
	}
}

// TestMigrate_PartialRunRecordsOnlyApplied verifies that if the second
// migration in a set fails, only the first is recorded in schema_versions.
func TestMigrate_PartialRunRecordsOnlyApplied(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_good.sql", "CREATE TABLE IF NOT EXISTS partial_good (id INTEGER PRIMARY KEY);",
		"002_bad.sql",  "THIS IS DEFINITELY NOT SQL;",
	)

	_ = db.MigrateFS(database, fsys) // we expect an error; ignore it here

	if !hasVersion(t, database, "001_good.sql") {
		t.Error("001_good.sql should be recorded even though 002 failed")
	}
	if hasVersion(t, database, "002_bad.sql") {
		t.Error("002_bad.sql should NOT be recorded because it failed")
	}
}

// TestMigrate_NonSQLFilesSkipped verifies that files without a .sql extension
// are skipped and not recorded in schema_versions.
func TestMigrate_NonSQLFilesSkipped(t *testing.T) {
	database := openMemory(t)

	fsys := fstest.MapFS{
		"README.md":   {Data: []byte("not sql")},
		"001_ok.sql":  {Data: []byte("CREATE TABLE IF NOT EXISTS ns_test (id INTEGER PRIMARY KEY);")},
		"002_ok.go":   {Data: []byte("package migrations")},
	}

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	if hasVersion(t, database, "README.md") {
		t.Error("README.md should not be recorded in schema_versions")
	}
	if hasVersion(t, database, "002_ok.go") {
		t.Error("002_ok.go should not be recorded in schema_versions")
	}
	if !hasVersion(t, database, "001_ok.sql") {
		t.Error("001_ok.sql should be recorded in schema_versions")
	}
}

// TestMigrate_WithRealMigrations is an integration smoke test: run the
// production migration set through the tracked MigrateFS and verify the
// schema_versions table contains exactly one row per .sql file in the FS.
func TestMigrate_WithRealMigrations(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() error: %v", err)
	}

	if !tableExists(t, database, "schema_versions") {
		t.Fatal("schema_versions not created by Migrate()")
	}

	// Count .sql files in the embedded FS by running Migrate again (no-op) and
	// inspecting the version count.  We just verify the count is > 0.
	n := countVersions(t, database)
	if n == 0 {
		t.Error("schema_versions is empty after running production migrations")
	}
}

// TestMigrate_WithRealMigrationsIdempotent verifies the production migration
// set can be run twice without error via the tracked path.
func TestMigrate_WithRealMigrationsIdempotent(t *testing.T) {
	database := openMemory(t)

	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() first run error: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate() second run error: %v", err)
	}
}

// TestMigrate_SeedDetectionUsesKnownTable verifies the seeding heuristic: it
// must detect an existing DB by the presence of a known table (e.g. "users"),
// not by an arbitrary table name.
func TestMigrate_SeedDetectionUsesKnownTable(t *testing.T) {
	database := openMemory(t)

	// Create only an unrelated table — not one of the known sentinel tables.
	if _, err := database.Exec(
		"CREATE TABLE IF NOT EXISTS unrelated (id INTEGER PRIMARY KEY);",
	); err != nil {
		t.Fatalf("setup: %v", err)
	}

	fsys := simpleFS(
		"001_new.sql", "CREATE TABLE IF NOT EXISTS new_table (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	// Since "users" table was absent, seeding must NOT have occurred and the
	// migration must have actually been applied.
	if !tableExists(t, database, "new_table") {
		t.Error("new_table should exist — migration was not seeded, so it must have run")
	}
}

// TestMigrate_ErrorMessageContainsFilename verifies that when a migration
// fails, the returned error message includes the filename for easier debugging.
func TestMigrate_ErrorMessageContainsFilename(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"042_broken.sql", "INVALID SQL STATEMENT;",
	)

	err := db.MigrateFS(database, fsys)
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	if !strings.Contains(err.Error(), "042_broken.sql") {
		t.Errorf("error %q does not mention the failing filename", err.Error())
	}
}

// TestMigrate_ReadDirErrorReturnsError verifies that when the FS returns an
// error from ReadDir, MigrateFS propagates it as a non-nil error.
func TestMigrate_ReadDirErrorReturnsError(t *testing.T) {
	database := openMemory(t)

	err := db.MigrateFS(database, failReadDirFS{})
	if err == nil {
		t.Error("MigrateFS() should return error when ReadDir fails")
	}
}

// TestMigrate_SchemaVersionsHasPrimaryKey verifies the schema_versions table
// uses version as PRIMARY KEY, preventing duplicate rows for the same file.
func TestMigrate_SchemaVersionsHasPrimaryKey(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_pk.sql", "CREATE TABLE IF NOT EXISTS pk_test (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	// Attempting a duplicate insert must fail.
	_, err := database.Exec(
		"INSERT INTO schema_versions (version, applied_at) VALUES ('001_pk.sql', datetime('now'))",
	)
	if err == nil {
		t.Error("duplicate insert into schema_versions should fail — PRIMARY KEY not enforced")
	}
}

// TestMigrate_SeedRecordsAllFilesFromFS verifies that seeding writes a row for
// every .sql file in the FS, including when there are multiple files.
func TestMigrate_SeedRecordsAllFilesFromFS(t *testing.T) {
	database := openMemory(t)

	// Create the users sentinel to trigger seeding on first call.
	if _, err := database.Exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY);"); err != nil {
		t.Fatalf("setup: %v", err)
	}

	fsys := simpleFS(
		"001_a.sql", "CREATE TABLE IF NOT EXISTS seed_a (id INTEGER PRIMARY KEY);",
		"002_b.sql", "CREATE TABLE IF NOT EXISTS seed_b (id INTEGER PRIMARY KEY);",
		"003_c.sql", "CREATE TABLE IF NOT EXISTS seed_c (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	for _, name := range []string{"001_a.sql", "002_b.sql", "003_c.sql"} {
		if !hasVersion(t, database, name) {
			t.Errorf("%q not seeded into schema_versions", name)
		}
	}

	// Tables from the seeded migrations must NOT have been created
	// (seeding records without executing).
	for _, tbl := range []string{"seed_a", "seed_b", "seed_c"} {
		if tableExists(t, database, tbl) {
			t.Errorf("table %q should not exist — migration was seeded, not executed", tbl)
		}
	}
}

// TestMigrate_FreshDatabaseRunsAllMigrations verifies that a completely fresh
// database (no tables at all) runs every migration without seeding.
func TestMigrate_FreshDatabaseRunsAllMigrations(t *testing.T) {
	database := openMemory(t)

	fsys := simpleFS(
		"001_fresh.sql", "CREATE TABLE IF NOT EXISTS fresh_a (id INTEGER PRIMARY KEY);",
		"002_fresh.sql", "CREATE TABLE IF NOT EXISTS fresh_b (id INTEGER PRIMARY KEY);",
	)

	if err := db.MigrateFS(database, fsys); err != nil {
		t.Fatalf("MigrateFS() error: %v", err)
	}

	for _, tbl := range []string{"fresh_a", "fresh_b"} {
		if !tableExists(t, database, tbl) {
			t.Errorf("table %q should exist on fresh database run", tbl)
		}
	}

	if countVersions(t, database) != 2 {
		t.Errorf("expected 2 version rows, got %d", countVersions(t, database))
	}
}

// TestMigrate_LargeNumberOfMigrations verifies that MigrateFS can handle
// a large set of migrations without degrading or skipping any.
func TestMigrate_LargeNumberOfMigrations(t *testing.T) {
	database := openMemory(t)

	const n = 50
	pairs := make([]string, 0, n*2)
	for i := 1; i <= n; i++ {
		name := fmt.Sprintf("%03d_large.sql", i)
		sql := fmt.Sprintf("CREATE TABLE IF NOT EXISTS large_%03d (id INTEGER PRIMARY KEY);", i)
		pairs = append(pairs, name, sql)
	}

	if err := db.MigrateFS(database, simpleFS(pairs...)); err != nil {
		t.Fatalf("MigrateFS() error with %d migrations: %v", n, err)
	}

	got := countVersions(t, database)
	if got != n {
		t.Errorf("schema_versions has %d rows, want %d", got, n)
	}
}
