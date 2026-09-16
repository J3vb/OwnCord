package db

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/migrations"
	"github.com/J3vb/OwnCord/Server/rollback"
)

// B6-11 drills 5, 7 and 8 — corrupt, interrupted and rolled back. Each proves
// a claim the docs already make in prose, against a private copy of the alpha
// snapshot (docs/architecture/data-lifecycle.md, "Drill protocol"); the
// tracked file is never opened:
//
//   - Drill 7, TestB611_InterruptedMigrationRollsBack — a migration
//     interrupted between its DDL and its tracker row leaves nothing
//     half-applied: the next start re-applies it, once.
//   - Drill 8, TestB611_InterruptedRollbackLeavesSchema — a reversal that
//     stops mid-file (sqlite3 -bail, the operator flow in
//     Server/rollback/README.md) leaves the schema and schema_versions
//     exactly as they were.
//   - Drill 5, TestB611_CorruptFilesFailClosed — three damaged files (a page
//     flipped in place, the database truncated to half, the marker row's cell
//     overwritten) each fail closed rather than being served. One subtest per
//     file; the backup-file case is the restore handler's own gate and is
//     cited, not repeated.
//
// Run with -v to read which step each corrupt file stops at:
//
//	go test -count=1 -v -run 'TestB611_(Interrupted|Corrupt)' ./db/

// newestMigration names the newest migration in Server/migrations and the
// reversal in Server/rollback that undoes it. The drill reads the pair rather
// than naming 051, so the next migration is drilled the day it lands; the
// reversal's absence is a failure here rather than a drill of the wrong file.
func newestMigration(t *testing.T) (string, string) {
	t.Helper()
	names, err := sqlFilenames(migrations.FS)
	if err != nil {
		t.Fatalf("listing Server/migrations: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("Server/migrations holds no migration")
	}
	migration := names[len(names)-1]
	reversal := strings.TrimSuffix(migration, ".sql") + ".down.sql"
	if _, err := rollback.FS.ReadFile(reversal); err != nil {
		t.Fatalf("%s has no %s in Server/rollback: %v", migration, reversal, err)
	}
	return migration, reversal
}

// fileSize is a missing-file-safe size, for the drill logs that say how far
// an interrupted write got.
func fileSize(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "absent"
	}
	return strconv.FormatInt(info.Size(), 10) + " bytes"
}

// copySidecar copies one file of a SQLite database, tolerating an absent one
// (a checkpointed database has no -wal and no -shm). Windows refuses the read
// of a -shm a live connection holds region locks on; that file is a derived
// index SQLite rebuilds from the WAL on the next open, so a refused read is
// logged and skipped rather than fatal — the crash image is still the database
// and its log.
func copySidecar(t *testing.T, src, dst string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		if strings.HasSuffix(src, "-shm") {
			t.Logf("skipping %s (%v): it is a derived index, rebuilt from the WAL", filepath.Base(src), err)
			return
		}
		t.Fatalf("reading %s: %v", src, err)
	}
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		t.Fatalf("writing %s: %v", dst, err)
	}
}

// Drill 7 — the interrupted migration. The fixture is built in the order the
// crash happens in: a copy of the snapshot migrated to HEAD (so the newest
// migration's statements have the schema they were written against), its
// reversal applied (an operator's rollback, putting the database back at the
// level the migration is applied to), then the migration's own statements
// hand-executed inside an open transaction with no tracker row and no COMMIT.
// The copy of db + -wal (and -shm where the OS allows it; see copySidecar)
// taken while that transaction is still open is the crash image — what the
// next start finds.
//
// The assertion is that the next start finds nothing half-applied, and that it
// ends up where an uninterrupted database ends up. The tracker row is absent,
// so the forward-only runner must apply the migration again; the migration's
// objects are absent from the crash image (the reversal at the top of the
// fixture removed them), so reaching the HEAD fingerprint requires the re-apply
// to have created them, and the tracker row then records it exactly once. What
// this proves is the re-apply path: the reversal is a genuine inverse, and
// MigrateFS brings the database from the pre-migration level back to the HEAD
// schema. The comparison is over sqlite_master's (type, name, sql) text, so it
// is a schema-object comparison, not a data one.
//
// Measured, and the reason this is a re-apply drill rather than a WAL-recovery
// one: on this fixture the interrupted statements never reach the -wal, so the
// crash image is the pre-transaction database. Spilling itself works — with
// cache_size=1 and cache_spill=1 read back from the pager, a ~2MB uncommitted
// transaction in the same session took the -wal from 902312 to 3658592 bytes —
// but the newest migration's two statements dirty too few pages to exceed the
// pager's minimum cache, and left the -wal at 902312 bytes before and 902312
// bytes after them. Recovering uncommitted frames from a WAL is therefore
// untested here; the log line records both sizes, so a platform or a future
// migration that does spill shows up in the drill's output rather than
// silently changing what was proven.
func TestB611_InterruptedMigrationRollsBack(t *testing.T) {
	ctx := context.Background()
	database, dbPath := drillCopy(t)
	migration, reversal := newestMigration(t)

	headSchema := schemaFingerprint(t, database)
	if n := countQ(t, database, `SELECT COUNT(*) FROM schema_versions WHERE version = ?`, migration); n != 1 {
		t.Fatalf("%s is recorded %d times on the HEAD copy, want 1", migration, n)
	}

	// Back to the level the migration is applied to, through the reversal an
	// operator runs (and the same file drill 8 interrupts).
	raw, err := rollback.FS.ReadFile(reversal)
	if err != nil {
		t.Fatalf("reading %s: %v", reversal, err)
	}
	applyReversal(t, database, reversal, string(raw))
	if n := countQ(t, database, `SELECT COUNT(*) FROM schema_versions WHERE version = ?`, migration); n != 0 {
		t.Fatalf("%s is still recorded after %s: %d rows", migration, reversal, n)
	}
	preSchema := schemaFingerprint(t, database)
	if preSchema == headSchema {
		t.Fatalf("%s changed nothing; the drill needs a migration with a schema in it", reversal)
	}

	// The interrupted migration: its own statements, no tracker row, no
	// COMMIT — the process dies here.
	up, err := migrations.FS.ReadFile(migration)
	if err != nil {
		t.Fatalf("reading %s: %v", migration, err)
	}
	walBefore := fileSize(dbPath + "-wal")
	tx, err := database.writer.Begin()
	if err != nil {
		t.Fatalf("begin the interrupted migration: %v", err)
	}
	// The interrupted transaction holds the writer pool's one connection.
	// Every failure below has to give it back before the test's cleanup
	// closes the database, or the close queues behind it forever.
	defer func() { _ = tx.Rollback() }()
	statements := splitStatements(string(up))
	for _, stmt := range statements {
		if _, err := tx.Exec(stmt); err != nil {
			t.Fatalf("executing %s by hand: %v\nstatement: %s", migration, err, stmt)
		}
	}
	t.Logf("interrupted %s mid-transaction: %d statements executed, no tracker row, no COMMIT, -wal %s → %s",
		migration, len(statements), walBefore, fileSize(dbPath+"-wal"))

	crashDir := t.TempDir()
	crashPath := filepath.Join(crashDir, filepath.Base(dbPath))
	// -shm is best-effort: Windows refuses the read while a live connection
	// holds it, which is why the copy is logged and skipped there.
	for _, sidecar := range []string{"", "-wal", "-shm"} {
		copySidecar(t, dbPath+sidecar, crashPath+sidecar)
	}
	_ = tx.Rollback()
	if err := database.Close(); err != nil {
		t.Fatalf("closing the source copy: %v", err)
	}

	image, err := Open(crashPath)
	if err != nil {
		t.Fatalf("db.Open on the crash image: %v", err)
	}
	defer func() { _ = image.Close() }()

	// Nothing half-applied: no tracker row, and the schema the transaction
	// was building is not there either.
	if n := countQ(t, image, `SELECT COUNT(*) FROM schema_versions WHERE version = ?`, migration); n != 0 {
		t.Fatalf("the crash image records %s %d times; the interrupted transaction reached the tracker", migration, n)
	}
	if got := schemaFingerprint(t, image); got != preSchema {
		t.Fatalf("the crash image carries a schema the interrupted migration left behind:\n%s", firstSchemaDiff(preSchema, got))
	}

	// The next start: the forward-only runner re-applies it, once.
	if err := MigrateFS(image, migrations.FS); err != nil {
		t.Fatalf("MigrateFS on the crash image: %v — the interrupted migration was not re-appliable", err)
	}
	if n := countQ(t, image, `SELECT COUNT(*) FROM schema_versions WHERE version = ?`, migration); n != 1 {
		t.Errorf("%s recorded %d times after MigrateFS, want exactly 1", migration, n)
	}
	if got := schemaFingerprint(t, image); got != headSchema {
		t.Errorf("MigrateFS on the crash image did not reach the uninterrupted HEAD schema — a statement was skipped or half-applied:\n%s", firstSchemaDiff(headSchema, got))
	}
	var verdict string
	if err := image.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&verdict); err != nil {
		t.Fatalf("integrity_check on the migrated crash image: %v", err)
	}
	if verdict != "ok" {
		t.Errorf("integrity_check after migrating the crash image = %q, want ok", verdict)
	}
}

// Drill 8 — the interrupted rollback. An operator runs a reversal by piping it
// to sqlite3 wrapped in BEGIN/COMMIT and with -bail, so the first statement
// that fails ends the run with the transaction still open and uncommitted.
// The fixture reproduces exactly that against a HEAD copy: BEGIN, the first
// half of the newest reversal's statements, a statement that cannot execute,
// then the process going away. SQLite's DDL is transactional, so nothing of
// the reversal may survive — not the schema change, not the tracker row.
//
// The second half runs the whole reversal list the way the B4 rehearsal does,
// to prove the interrupted file was the real reversal of a real migration
// rather than a fixture that could not have changed anything.
func TestB611_InterruptedRollbackLeavesSchema(t *testing.T) {
	// The snapshot's own schema, as the round trip at the end must land on it.
	fresh := openSnapshotCopy(t)
	baseSchema := schemaFingerprint(t, fresh)
	baseVersions := appliedVersions(t, fresh)

	database, dbPath := drillCopy(t)
	migration, reversal := newestMigration(t)
	if got := rollback.Migration(reversal); got != migration {
		t.Fatalf("rollback.Migration(%s) = %s, want %s — the naming contract is broken", reversal, got, migration)
	}

	before := schemaFingerprint(t, database)
	beforeVersions := appliedVersions(t, database)
	if !slices.Contains(beforeVersions, migration) {
		t.Fatalf("HEAD never recorded %s", migration)
	}

	raw, err := rollback.FS.ReadFile(reversal)
	if err != nil {
		t.Fatalf("reading %s: %v", reversal, err)
	}
	statements := splitStatements(string(raw))
	if len(statements) < 2 {
		t.Fatalf("%s has %d statements; the drill needs a schema change and the tracker delete", reversal, len(statements))
	}
	half := statements[:len(statements)/2]

	// The operator's CLI: one connection, no pool, transaction control of its
	// own. Closing it with the transaction open is what -bail exiting does.
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(dbPath)+"?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("opening the operator's connection: %v", err)
	}
	conn.SetMaxOpenConns(1)
	defer func() { _ = conn.Close() }()
	if _, err := conn.Exec("BEGIN"); err != nil {
		t.Fatalf("BEGIN: %v", err)
	}
	for _, stmt := range half {
		if _, err := conn.Exec(stmt); err != nil {
			t.Fatalf("executing the first half of %s: %v\nstatement: %s", reversal, err, stmt)
		}
	}
	const broken = `DROP TABLE b6_11_drill_typo`
	if _, err := conn.Exec(broken); err == nil {
		t.Fatalf("the deliberately broken statement executed — this fixture proves nothing")
	} else {
		t.Logf("interrupted %s after %d of its %d statements: %v, then the connection goes away with the transaction open",
			reversal, len(half), len(statements), err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("closing the operator's connection: %v", err)
	}

	// Nothing of the reversal survives the bail.
	if got := schemaFingerprint(t, database); got != before {
		t.Fatalf("the interrupted reversal changed the schema:\n%s", firstSchemaDiff(before, got))
	}
	if got := appliedVersions(t, database); !slices.Equal(got, beforeVersions) {
		t.Fatalf("schema_versions after the interrupted reversal holds %d rows, want the %d it held before — a tracker row was cleared without its reversal committing", len(got), len(beforeVersions))
	}

	// The interrupted file was the real reversal of a real migration: run the
	// whole list, as the B4 rehearsal does, and it lands on the snapshot's
	// schema.
	for _, name := range rollback.Order {
		file, err := rollback.FS.ReadFile(name)
		if err != nil {
			t.Fatalf("reading %s: %v", name, err)
		}
		applyReversal(t, database, name, string(file))
	}
	if got := schemaFingerprint(t, database); got != baseSchema {
		t.Errorf("the full reversal from the interrupted database did not reach the snapshot's schema:\n%s", firstSchemaDiff(baseSchema, got))
	}
	if got := appliedVersions(t, database); !slices.Equal(got, baseVersions) {
		t.Errorf("the full reversal left %d applied migrations, want the snapshot's %d", len(got), len(baseVersions))
	}
}

// b611HeadCopy is a snapshot copy migrated to HEAD and then closed. The close
// is the point: it checkpoints the WAL and removes the -wal/-shm sidecars, so
// the main file is the only copy of the database and a byte flipped in it is
// the only version of that page a reader can find.
func b611HeadCopy(t *testing.T) (string, string) {
	t.Helper()
	database, path := drillCopy(t)
	if err := database.Close(); err != nil {
		t.Fatalf("closing the HEAD copy: %v", err)
	}
	return filepath.Dir(path), path
}

// corruptBytes overwrites n bytes at offset with a pattern no b-tree page can
// be — the drill's stand-in for a damaged file, past the page header so the
// damage is in the page's contents rather than in its type.
func corruptBytes(t *testing.T, path string, offset int64, n int) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatalf("opening %s to corrupt it: %v", path, err)
	}
	if _, err := f.WriteAt(bytes.Repeat([]byte{0xFF}, n), offset); err != nil {
		_ = f.Close()
		t.Fatalf("corrupting %s at %d: %v", path, offset, err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("closing %s: %v", path, err)
	}
}

// b611BootRead is the read the start-up sequence ends on: a scan of the users
// table, which is page 7 of this fixture (b611PageOwner reports the same for
// the file a drill is about to damage) and therefore the table the flipped
// page damages. The read has to reach the damaged page to say anything about
// it — a read that skips it reports success for a reason that has nothing to
// do with the damage.
const b611BootRead = `SELECT COALESCE(SUM(LENGTH(username)), 0) FROM users`

// b611Boot runs the start-up sequence the server runs against path — Open,
// MigrateFS, the marker stage, then one read — and returns the first step that
// errored. An empty step name means every step reported success, which on a
// corrupt file is the fail-open the drill is looking for.
//
// The marker stage is OpenMarkerStore followed by the store's own read of the
// markers, because that is what the server's stage does: Server/internal/app's
// openMarkers opens the file and then replays it (MarkerStore.ReplayAccounts,
// which begins by reading deletion_markers), and start-up fails if either
// half does. It cannot be called from here — internal/app imports db — so the
// drill runs its two halves directly.
func b611Boot(t *testing.T, dir, path string) (string, error) {
	t.Helper()
	ctx := context.Background()
	database, err := Open(path)
	if err != nil {
		return "db.Open", err
	}
	defer func() { _ = database.Close() }()

	if err := MigrateFS(database, migrations.FS); err != nil {
		return "db.MigrateFS", err
	}
	markers, err := OpenMarkerStore(filepath.Join(dir, "erasure", "markers.sqlite"), testMarkerKey(9))
	if err != nil {
		return "db.OpenMarkerStore", err
	}
	defer func() { _ = markers.Close() }()

	if _, err := markers.Markers(ctx); err != nil {
		return "MarkerStore read", err
	}
	var total int
	if err := database.QueryRowContext(ctx, b611BootRead).Scan(&total); err != nil {
		return "read users", err
	}
	return "", nil
}

// b611CellStart returns the file offset of the first cell of a leaf table
// page. The marker drill damages the cell rather than a fixed small offset
// inside the page: a page's cells live at its end and the space under the cell
// pointer array is unallocated, so bytes flipped at, say, offset 100 of a
// one-row page land in space SQLite never reads and the "corruption" proves
// nothing.
func b611CellStart(t *testing.T, path string, page int) int64 {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("opening %s: %v", path, err)
	}
	defer func() { _ = f.Close() }()

	header := make([]byte, 18)
	if _, err := f.ReadAt(header, 0); err != nil {
		t.Fatalf("reading the header of %s: %v", path, err)
	}
	pageSize := int64(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	pageStart := int64(page-1) * pageSize
	pageBuf := make([]byte, pageSize)
	if _, err := f.ReadAt(pageBuf, pageStart); err != nil {
		t.Fatalf("reading page %d of %s: %v", page, path, err)
	}
	if pageBuf[0] != 0x0d {
		t.Fatalf("page %d of %s is not a leaf table page (first byte %#x) — the fixture's layout moved", page, path, pageBuf[0])
	}
	if binary.BigEndian.Uint16(pageBuf[3:5]) == 0 {
		t.Fatalf("page %d of %s holds no cells", page, path)
	}
	return pageStart + int64(binary.BigEndian.Uint16(pageBuf[8:10]))
}

// b611PageOwner names the nearest schema object whose root page is at or before
// page, so a drill's log says what the bytes it flipped are most likely inside
// rather than only where. SQLite allocates a b-tree's pages from its root
// upward, so for a page that is in use this is the object that owns it — but
// the lookup does not verify that the page is in use, and it is a log line, not
// something the drill asserts on.
func b611PageOwner(t *testing.T, path string, page int) string {
	t.Helper()
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return "open: " + err.Error()
	}
	defer func() { _ = conn.Close() }()
	var typ, name string
	var root int
	if err := conn.QueryRow(
		`SELECT type, name, rootpage FROM sqlite_master WHERE rootpage <= ? ORDER BY rootpage DESC LIMIT 1`, page,
	).Scan(&typ, &name, &root); err != nil {
		return "lookup: " + err.Error()
	}
	return fmt.Sprintf("%s %s (root page %d)", typ, name, root)
}

// b611IntegrityReport runs PRAGMA integrity_check against a file directly,
// outside the boot sequence, so the drill can say whether a step the server
// does not run would have caught the damage at all.
func b611IntegrityReport(t *testing.T, path string) string {
	t.Helper()
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro&_pragma=busy_timeout(2000)")
	if err != nil {
		return "open: " + err.Error()
	}
	defer func() { _ = conn.Close() }()
	rows, err := conn.Query("PRAGMA integrity_check")
	if err != nil {
		return "integrity_check: " + err.Error()
	}
	defer func() { _ = rows.Close() }()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return "scan: " + err.Error()
		}
		lines = append(lines, line)
		if len(lines) == 4 {
			lines = append(lines, "...")
			break
		}
	}
	if err := rows.Err(); err != nil {
		return "integrity_check: " + err.Error()
	}
	return strings.Join(lines, "; ")
}

// Drill 5 — corrupt files fail closed. Each corrupt input is run through the
// sequence the server runs at start-up (Open → MigrateFS → the marker stage →
// one read over the damaged table) and the drill asserts that sequence does
// not report success: a corrupt file the server boots on and serves is the
// fail-open. Which step stops, and with what, is logged per subtest and
// reported.
//
// The drill damages a page rather than the file's header, and reads the table
// that page is part of, because those are the terms of the question: a file
// whose header SQLite rejects is refused by every step, which says nothing
// about a page the boot never reads.
//
// Measured on the alpha fixture. The flipped page (the users table's root,
// page 7): db.Open and db.MigrateFS both report success — they read the
// schema, the tracker and the pragmas, never that table — and the boot stops
// at the read over it, with "database disk image is malformed". PRAGMA
// integrity_check does detect it, so the corruption is real; a boot-time check
// is not what start-up runs today, and whether one belongs there is an open
// question rather than something this drill added. The truncated file is the
// interrupted-restore image data-lifecycle.md:238 describes, and db.Open
// refuses it ("pinging sqlite db: database disk image is malformed"), as that
// line claims.
//
// Backup files are the fourth case and are cited rather than repeated here:
// handleRestoreBackup refuses a file that fails db.CheckBackupIntegrity with
// 400 before it touches the live database (Server/admin/handlers_backup.go,
// "restore refused: backup failed integrity check"), and
// TestCheckBackupIntegrity_ValidAndCorrupt (backup_test.go) covers the gate
// itself, corrupt and missing.
func TestB611_CorruptFilesFailClosed(t *testing.T) {
	t.Run("main database, flipped page", func(t *testing.T) {
		dir, path := b611HeadCopy(t)
		t.Logf("page 7 of the HEAD copy is %s; the boot sequence's read is over that table", b611PageOwner(t, path, 7))

		// Control: the same sequence reports success on the same copy before
		// the page is damaged, so the failure below is the damage rather than
		// a boot sequence that cannot succeed on anything.
		if step, err := b611Boot(t, dir, path); err != nil {
			t.Fatalf("the start-up sequence failed on the intact copy at %s: %v", step, err)
		}
		corruptBytes(t, path, 4096*7+100, 64)

		step, err := b611Boot(t, dir, path)
		t.Logf("flipped 64 bytes at %d: PRAGMA integrity_check says %q", 4096*7+100, b611IntegrityReport(t, path))
		if err == nil {
			t.Fatalf("the start-up sequence reported success on a database with 64 bytes of page 7 (%s) overwritten: a corrupt database is being served",
				b611PageOwner(t, path, 7))
		}
		t.Logf("boot stopped at %s: %v", step, err)
	})

	t.Run("main database, truncated to half", func(t *testing.T) {
		dir, path := b611HeadCopy(t)
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if err := os.Truncate(path, info.Size()/2); err != nil {
			t.Fatalf("truncating %s: %v", path, err)
		}

		step, err := b611Boot(t, dir, path)
		t.Logf("truncated to %d of %d bytes: PRAGMA integrity_check says %q", info.Size()/2, info.Size(), b611IntegrityReport(t, path))
		if err == nil {
			t.Fatalf("the start-up sequence reported success on a database truncated to %d of %d bytes", info.Size()/2, info.Size())
		}
		t.Logf("boot stopped at %s: %v", step, err)
	})

	t.Run("markers.sqlite corrupt", func(t *testing.T) {
		dir, path := b611HeadCopy(t)
		markerPath := filepath.Join(dir, "erasure", "markers.sqlite")
		ctx := context.Background()

		// A marker file with a real marker in it: an erasure that a restore of
		// an older backup would otherwise bring back.
		store, err := OpenMarkerStore(markerPath, testMarkerKey(9))
		if err != nil {
			t.Fatalf("OpenMarkerStore: %v", err)
		}
		token, _, err := store.RecordPendingAccount(ctx, 7, 7)
		if err != nil {
			t.Fatalf("RecordPendingAccount: %v", err)
		}
		if err := store.ConfirmAccount(ctx, token); err != nil {
			t.Fatalf("ConfirmAccount: %v", err)
		}
		if err := store.Close(); err != nil {
			t.Fatalf("closing the marker store: %v", err)
		}

		info, err := os.Stat(markerPath)
		if err != nil {
			t.Fatalf("stat %s: %v", markerPath, err)
		}
		cell := b611CellStart(t, markerPath, 2)
		t.Logf("page 2 of the marker file is %s; the marker row's cell starts at offset %d and 16 bytes of it are overwritten", b611PageOwner(t, markerPath, 2), cell)
		corruptBytes(t, markerPath, cell, 16)

		// The main database is intact, so only the marker file can be what
		// stops the boot: a start-up that proceeds did so on a file whose
		// markers it never read.
		//
		// Where it stops is the measurement: db.OpenMarkerStore alone reports
		// success on this file — its schema statements read page 1 and the key
		// fingerprint reads marker_meta, neither of which is damaged — and it
		// is the stage's read of the markers that refuses. That is why the
		// stage, and not the open on its own, is the thing that has to hold.
		step, err := b611Boot(t, dir, path)
		if err == nil {
			t.Fatalf("the start-up sequence completed with the marker row's cell overwritten in %s (%d bytes): the deleted account's marker is skipped",
				filepath.Base(markerPath), info.Size())
		}
		if step != "MarkerStore read" && step != "db.OpenMarkerStore" {
			t.Errorf("the sequence stopped at %s, want one of the marker stages — the intact main database should carry it that far", step)
		}
		t.Logf("marker file %d bytes, 16 overwritten at %d: PRAGMA integrity_check says %q", info.Size(), cell, b611IntegrityReport(t, markerPath))
		t.Logf("boot stopped at %s: %v", step, err)
	})
}
