package db

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTestDB creates a SQLite file at path holding one table with the given
// marker values, in WAL mode so a live copy has sidecars like the server's.
func writeTestDB(t *testing.T, path string, vals ...string) {
	t.Helper()
	conn, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec("CREATE TABLE IF NOT EXISTS t (v TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, v := range vals {
		if _, err := conn.Exec("INSERT INTO t (v) VALUES (?)", v); err != nil {
			t.Fatal(err)
		}
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
}

func readTestDB(t *testing.T, path string) []string {
	t.Helper()
	conn, err := sql.Open("sqlite", readOnlyURI(path))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close() //nolint:errcheck
	rows, err := conn.Query("SELECT v FROM t ORDER BY rowid")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close() //nolint:errcheck
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatal(err)
		}
		out = append(out, v)
	}
	return out
}

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type stagedFixture struct {
	dir, live, backup string
}

// newStagedFixture builds a live database holding "live" and a backup holding
// "backup", both closed.
func newStagedFixture(t *testing.T) stagedFixture {
	t.Helper()
	dir := t.TempDir()
	f := stagedFixture{dir: dir, live: filepath.Join(dir, "chat.db"), backup: filepath.Join(dir, "backup.db")}
	writeTestDB(t, f.live, "live")
	writeTestDB(t, f.backup, "backup")
	return f
}

func (f stagedFixture) stage(t *testing.T) {
	t.Helper()
	m := StagedRestoreMarker{Backup: "backup.db", SafetyCopy: "pre_restore.db", ActorID: 7}
	if err := StageRestore(context.Background(), f.live, f.backup, m); err != nil {
		t.Fatalf("StageRestore: %v", err)
	}
}

func assertGone(t *testing.T, paths ...string) {
	t.Helper()
	for _, p := range paths {
		if fileExists(p) {
			t.Errorf("%s still exists", filepath.Base(p))
		}
	}
}

func assertRows(t *testing.T, path string, want ...string) {
	t.Helper()
	if got := readTestDB(t, path); !sameStrings(got, want) {
		t.Fatalf("rows in %s = %v, want %v", filepath.Base(path), got, want)
	}
}

func setStepHook(t *testing.T, fn func(string) error) {
	t.Helper()
	prev := restoreStepHook
	restoreStepHook = fn
	t.Cleanup(func() { restoreStepHook = prev })
}

func TestApplyStagedRestore_NoMarkerIsNoop(t *testing.T) {
	f := newStagedFixture(t)
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res != (RestoreResult{}) {
		t.Fatalf("ApplyStagedRestore = %+v, %v; want zero, nil", res, err)
	}
	assertRows(t, f.live, "live")
	if _, found, err := TakeRestoreResult(f.live); found || err != nil {
		t.Fatalf("TakeRestoreResult found=%v err=%v, want neither", found, err)
	}
}

func TestApplyStagedRestore_AppliesAndClearsMarker(t *testing.T) {
	f := newStagedFixture(t)
	// A -wal a dead server left behind must travel with the old database.
	if err := os.WriteFile(f.live+"-wal", []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	assertRows(t, f.live, "live") // staging never touches the live file

	res, err := ApplyStagedRestore(f.live)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != RestoreStatusApplied || res.Backup != "backup.db" || res.ActorID != 7 {
		t.Fatalf("result = %+v", res)
	}
	assertRows(t, f.live, "backup")
	assertGone(t, p.staged, p.marker, p.rollback, p.rollback+"-wal", p.rollback+"-shm", f.live+"-wal")

	got, found, err := TakeRestoreResult(f.live)
	if err != nil || !found || got.Status != RestoreStatusApplied || got.Backup != "backup.db" {
		t.Fatalf("TakeRestoreResult = %+v, %v, %v", got, found, err)
	}
	// Surfaced once: the second take finds nothing, and a second apply is a no-op.
	if _, found, _ := TakeRestoreResult(f.live); found {
		t.Fatal("restore result was returned twice")
	}
	if res, err := ApplyStagedRestore(f.live); err != nil || res != (RestoreResult{}) {
		t.Fatalf("second ApplyStagedRestore = %+v, %v", res, err)
	}
}

func TestApplyStagedRestore_OrphanStagedWithoutMarkerIsDeleted(t *testing.T) {
	f := newStagedFixture(t)
	p, _ := newRestorePaths(f.live)
	if err := os.WriteFile(p.staged, []byte("half a copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.stagedTmp, []byte("temp"), 0o600); err != nil {
		t.Fatal(err)
	}
	if res, err := ApplyStagedRestore(f.live); err != nil || res != (RestoreResult{}) {
		t.Fatalf("ApplyStagedRestore = %+v, %v", res, err)
	}
	assertGone(t, p.staged, p.stagedTmp)
	assertRows(t, f.live, "live")
}

func TestApplyStagedRestore_ResumesAfterCrashBetweenAsideAndSwap(t *testing.T) {
	for _, crashAt := range []string{"aside-main", "aside"} {
		t.Run(crashAt, func(t *testing.T) {
			f := newStagedFixture(t)
			if err := os.WriteFile(f.live+"-wal", []byte("stale"), 0o600); err != nil {
				t.Fatal(err)
			}
			f.stage(t)
			crash := errors.New("simulated crash")
			setStepHook(t, func(step string) error {
				if step == crashAt {
					return crash
				}
				return nil
			})
			if _, err := ApplyStagedRestore(f.live); !errors.Is(err, crash) {
				t.Fatalf("first apply = %v, want the simulated crash", err)
			}
			p, _ := newRestorePaths(f.live)
			if fileExists(f.live) || !fileExists(p.rollback) || !fileExists(p.staged) || !fileExists(p.marker) {
				t.Fatal("expected the half-swapped state: live absent, rollback + staged + marker present")
			}

			setStepHook(t, func(string) error { return nil })
			res, err := ApplyStagedRestore(f.live)
			if err != nil || res.Status != RestoreStatusApplied {
				t.Fatalf("recovery apply = %+v, %v", res, err)
			}
			assertRows(t, f.live, "backup")
			assertGone(t, p.staged, p.marker, p.rollback, p.rollback+"-wal", f.live+"-wal")
		})
	}
}

func TestApplyStagedRestore_ResumesAfterCrashBeforeMarkerCleanup(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	crash := errors.New("simulated crash")
	setStepHook(t, func(step string) error {
		if step == "result" {
			return crash
		}
		return nil
	})
	if _, err := ApplyStagedRestore(f.live); !errors.Is(err, crash) {
		t.Fatalf("first apply = %v", err)
	}
	setStepHook(t, func(string) error { return nil })
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusApplied {
		t.Fatalf("recovery apply = %+v, %v", res, err)
	}
	assertRows(t, f.live, "backup")
	p, _ := newRestorePaths(f.live)
	assertGone(t, p.marker, p.rollback)
}

func TestApplyStagedRestore_RollsBackOnFailedIntegrity(t *testing.T) {
	f := newStagedFixture(t)
	if err := os.WriteFile(f.live+"-wal", []byte("kept with its database"), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(f.live)
	if err != nil {
		t.Fatal(err)
	}
	f.stage(t)
	prev := checkSwapped
	checkSwapped = func(context.Context, string) error { return errors.New("simulated corruption") }
	t.Cleanup(func() { checkSwapped = prev })

	res, err := ApplyStagedRestore(f.live)
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != RestoreStatusRolledBack || res.Error == "" {
		t.Fatalf("result = %+v, want rolled_back with a reason", res)
	}
	after, err := os.ReadFile(f.live)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("live database is not byte for byte the pre-restore file")
	}
	if wal, err := os.ReadFile(f.live + "-wal"); err != nil || string(wal) != "kept with its database" {
		t.Fatalf("live -wal = %q, %v; want it back beside its database", wal, err)
	}
	p, _ := newRestorePaths(f.live)
	assertGone(t, p.staged, p.marker, p.rollback, p.rollback+"-wal")
	if got, found, _ := TakeRestoreResult(f.live); !found || got.Status != RestoreStatusRolledBack {
		t.Fatalf("result file = %+v, %v", got, found)
	}
}

func TestApplyStagedRestore_ResumesInterruptedRollback(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	prev := checkSwapped
	checkSwapped = func(context.Context, string) error { return errors.New("simulated corruption") }
	t.Cleanup(func() { checkSwapped = prev })
	// Crash right after the failed restored file is deleted: only the rollback
	// file and the marker remain.
	p, _ := newRestorePaths(f.live)
	setStepHook(t, func(step string) error {
		if step == "swapped" {
			// Emulate the crash window by running the rollback's first half by hand.
			return errors.New("simulated crash")
		}
		return nil
	})
	if _, err := ApplyStagedRestore(f.live); err == nil {
		t.Fatal("expected the simulated crash")
	}
	if err := removeAll(p.db); err != nil {
		t.Fatal(err)
	}
	setStepHook(t, func(string) error { return nil })
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRolledBack {
		t.Fatalf("recovery = %+v, %v", res, err)
	}
	assertRows(t, f.live, "live")
}

func TestApplyStagedRestore_HashMismatchRefusesWithoutTouchingLive(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	// Replace the staged file with a different, valid database.
	if err := os.Remove(p.staged); err != nil {
		t.Fatal(err)
	}
	writeTestDB(t, p.staged, "tampered")
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRefused {
		t.Fatalf("result = %+v, %v; want refused", res, err)
	}
	assertRows(t, f.live, "live")
	assertGone(t, p.staged, p.marker, p.rollback)
}

func TestApplyStagedRestore_InconsistentStateRefusesNamedError(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	if err := os.WriteFile(p.rollback, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := ApplyStagedRestore(f.live)
	if !errors.Is(err, ErrRestoreInconsistent) {
		t.Fatalf("err = %v, want ErrRestoreInconsistent", err)
	}
	for _, path := range []string{f.live, p.staged, p.marker, p.rollback} {
		if !fileExists(path) {
			t.Errorf("%s was removed; an inconsistent state must be left alone", filepath.Base(path))
		}
	}
	// A torn marker is the same refusal.
	if err := os.Remove(p.rollback); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.marker, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ApplyStagedRestore(f.live); !errors.Is(err, ErrRestoreInconsistent) {
		t.Fatalf("torn marker err = %v", err)
	}
}

func TestApplyStagedRestore_MovesLeftoverWALAside(t *testing.T) {
	f := newStagedFixture(t)
	// A WAL from the old database must never be replayed onto the restored one.
	if err := os.WriteFile(f.live+"-wal", []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.live+"-shm", []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.stage(t)
	if _, err := ApplyStagedRestore(f.live); err != nil {
		t.Fatal(err)
	}
	assertGone(t, f.live+"-wal", f.live+"-shm")
	assertRows(t, f.live, "backup")
}

func TestApplyStagedRestore_AdvancesRetryFloorBeforeSwap(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	if floor, err := readMessageDeliveryFloor(f.live); err != nil || floor != 0 {
		t.Fatalf("floor before = %d, %v", floor, err)
	}
	if _, err := ApplyStagedRestore(f.live); err != nil {
		t.Fatal(err)
	}
	if floor, err := readMessageDeliveryFloor(f.live); err != nil || floor == 0 {
		t.Fatalf("floor after = %d, %v; want advanced", floor, err)
	}
}

func TestStageRestore_RefusesSecondStageAndBadSource(t *testing.T) {
	f := newStagedFixture(t)
	bad := filepath.Join(f.dir, "bad.db")
	if err := os.WriteFile(bad, []byte("not a database at all, just text padding the file out"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := StageRestore(context.Background(), f.live, bad, StagedRestoreMarker{Backup: "bad.db"})
	if err == nil {
		t.Fatal("staging a non-database succeeded")
	}
	p, _ := newRestorePaths(f.live)
	assertGone(t, p.staged, p.stagedTmp, p.marker)

	f.stage(t)
	err = StageRestore(context.Background(), f.live, f.backup, StagedRestoreMarker{Backup: "backup.db"})
	if !errors.Is(err, ErrRestoreAlreadyStaged) {
		t.Fatalf("second stage = %v, want ErrRestoreAlreadyStaged", err)
	}
}

func TestOpen_AppliesStagedRestoreUnderTheLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chat.db")
	backup := filepath.Join(dir, "backup.db")
	writeTestDB(t, path, "live")
	writeTestDB(t, backup, "backup")
	if err := StageRestore(context.Background(), path, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
		t.Fatal(err)
	}
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var v string
	if err := d.SQLDb().QueryRow("SELECT v FROM t").Scan(&v); err != nil || v != "backup" {
		t.Fatalf("Open served %q, %v; want the restored rows", v, err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if res, found, err := TakeRestoreResult(path); err != nil || !found || res.Status != RestoreStatusApplied {
		t.Fatalf("result = %+v, %v, %v", res, found, err)
	}
}

// crashAt makes the apply stop at the named step, as a kill would.
func crashAt(t *testing.T, step string) {
	t.Helper()
	setStepHook(t, func(s string) error {
		if s == step {
			return errors.New("simulated crash")
		}
		return nil
	})
}

func noCrash(t *testing.T) { t.Helper(); setStepHook(t, func(string) error { return nil }) }

// A crash after the old -wal was moved back but before the old main file was:
// the resume must not delete the sidecar it just restored.
func TestApplyStagedRestore_RollbackResumeKeepsOldWAL(t *testing.T) {
	f := newStagedFixture(t)
	if err := os.WriteFile(f.live+"-wal", []byte("old wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	crashAt(t, "swapped")
	if _, err := ApplyStagedRestore(f.live); err == nil {
		t.Fatal("expected the simulated crash")
	}
	// The interrupted rollback: restored files removed, sidecars moved back,
	// killed before the main file moved.
	if err := removeIfPresent(p.db+"-wal", p.db+"-shm", p.db); err != nil {
		t.Fatal(err)
	}
	if err := moveSidecars(p.rollback, p.db); err != nil {
		t.Fatal(err)
	}
	noCrash(t)
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRolledBack {
		t.Fatalf("recovery = %+v, %v", res, err)
	}
	if b, err := os.ReadFile(f.live + "-wal"); err != nil || string(b) != "old wal" {
		t.Fatalf("old WAL lost: %q, %v", b, err)
	}
	assertRows(t, f.live, "live")
}

// A refusal whose staged copy vanished (killed after discarding it, or removed
// by hand) must never be reported as applied.
func TestApplyStagedRestore_MissingStagedCopyIsNotApplied(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	if err := os.Remove(p.staged); err != nil {
		t.Fatal(err)
	}
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRefused {
		t.Fatalf("result = %+v, %v; want refused", res, err)
	}
	assertRows(t, f.live, "live")
	assertGone(t, p.marker)
}

// A refusal recorded before a crash stays refused: the resume neither
// overwrites it with applied nor loses the staged-copy cleanup.
func TestApplyStagedRestore_RefusalSurvivesCrashBeforeMarkerRemoval(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	// Corrupt the staged copy so the checksum refuses it.
	if err := os.Remove(p.staged); err != nil {
		t.Fatal(err)
	}
	writeTestDB(t, p.staged, "tampered")
	crashAt(t, "result")
	if _, err := ApplyStagedRestore(f.live); err == nil {
		t.Fatal("expected the simulated crash")
	}
	noCrash(t)
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRefused {
		t.Fatalf("resume = %+v, %v; want refused", res, err)
	}
	assertRows(t, f.live, "live")
	assertGone(t, p.marker, p.staged)
	// And with the staged copy already gone, the recorded refusal is kept.
	f2 := newStagedFixture(t)
	f2.stage(t)
	p2, _ := newRestorePaths(f2.live)
	if err := os.Remove(p2.staged); err != nil {
		t.Fatal(err)
	}
	writeTestDB(t, p2.staged, "tampered")
	crashAt(t, "result")
	_, _ = ApplyStagedRestore(f2.live)
	if err := os.Remove(p2.staged); err != nil {
		t.Fatal(err)
	}
	noCrash(t)
	res, err = ApplyStagedRestore(f2.live)
	if err != nil || res.Status != RestoreStatusRefused || res.Error == "the staged copy is missing" {
		t.Fatalf("recorded refusal not kept: %+v, %v", res, err)
	}
}

// An applied result survives a crash between deleting the replaced database
// and removing the marker.
func TestApplyStagedRestore_AppliedSurvivesCrashBeforeMarkerRemoval(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	calls := 0
	setStepHook(t, func(s string) error {
		if s == "result" {
			calls++
		}
		return nil
	})
	if _, err := ApplyStagedRestore(f.live); err != nil {
		t.Fatal(err)
	}
	// Rebuild the crash window by hand: marker back, rollback gone, result present.
	m := StagedRestoreMarker{Backup: "backup.db", ActorID: 7}
	data, _ := json.Marshal(m)
	if err := os.WriteFile(p.marker, data, 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusApplied {
		t.Fatalf("resume = %+v, %v; want applied", res, err)
	}
	assertRows(t, f.live, "backup")
}

// Deleting the marker by hand after the swap cancels the restore: the old
// database comes back and is never deleted.
func TestApplyStagedRestore_MarkerDeletedAfterSwapKeepsOldDatabase(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	crashAt(t, "swapped")
	if _, err := ApplyStagedRestore(f.live); err == nil {
		t.Fatal("expected the simulated crash")
	}
	if err := os.Remove(p.marker); err != nil {
		t.Fatal(err)
	}
	noCrash(t)
	if res, err := ApplyStagedRestore(f.live); err != nil || res != (RestoreResult{}) {
		t.Fatalf("apply = %+v, %v", res, err)
	}
	assertRows(t, f.live, "live")
	assertGone(t, p.rollback)
}

// An apply-time failure to preserve a floor refuses the restore and keeps the
// old database instead of blocking the boot.
func TestApplyStagedRestore_FloorFailureRefusesAndBoots(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	if err := os.Mkdir(f.live+".message-retry-floor", 0o700); err != nil {
		t.Fatal(err)
	}
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRefused {
		t.Fatalf("result = %+v, %v; want refused", res, err)
	}
	assertRows(t, f.live, "live")
	p, _ := newRestorePaths(f.live)
	assertGone(t, p.marker, p.staged, p.rollback)
}

// With no live database, a restored file that fails its check is not left as
// the live database.
func TestApplyStagedRestore_NoLiveDatabaseFailedCheckLeavesNoCorruptFile(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	if err := os.Remove(f.live); err != nil {
		t.Fatal(err)
	}
	prev := checkSwapped
	checkSwapped = func(context.Context, string) error { return errors.New("simulated corruption") }
	t.Cleanup(func() { checkSwapped = prev })
	res, err := ApplyStagedRestore(f.live)
	if err != nil || res.Status != RestoreStatusRolledBack {
		t.Fatalf("result = %+v, %v", res, err)
	}
	if fi, err := os.Stat(f.live); err == nil && fi.Size() != 0 {
		t.Fatalf("the restored file was left as the live database (%d bytes)", fi.Size())
	}
}

func TestOpen_InconsistentRestoreErrorIsNamed(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	if err := os.WriteFile(p.rollback, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(f.live)
	if !errors.Is(err, ErrRestoreInconsistent) || strings.Contains(err.Error(), "retry cutoff") {
		t.Fatalf("Open err = %v", err)
	}
}

// An empty database created while a restore was interrupted (a tool opening a
// missing live file) must not be mistaken for the restored one: the replaced
// database stays, and nothing is reported as applied.
func TestApplyStagedRestore_UnrelatedLiveDatabaseKeepsRollback(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	p, _ := newRestorePaths(f.live)
	crashAt(t, "aside")
	if _, err := ApplyStagedRestore(f.live); err == nil {
		t.Fatal("expected the simulated crash")
	}
	// Marker, rollback and staged exist, no live file; a tool creates one and
	// the staged copy is gone, as if the swap had finished.
	writeTestDB(t, f.live, "created by a tool")
	if err := os.Remove(p.staged); err != nil {
		t.Fatal(err)
	}
	noCrash(t)
	res, err := ApplyStagedRestore(f.live)
	if !errors.Is(err, ErrRestoreInconsistent) || res.Status == RestoreStatusApplied {
		t.Fatalf("apply = %+v, %v; want ErrRestoreInconsistent", res, err)
	}
	if !fileExists(p.rollback) || !fileExists(p.marker) {
		t.Fatal("the replaced database or marker was removed")
	}
	assertRows(t, p.rollback, "live")
}

func TestOpenShared_RefusesWhileRestoreIsInProgress(t *testing.T) {
	f := newStagedFixture(t)
	f.stage(t)
	if _, err := OpenShared(f.live); !errors.Is(err, ErrRestoreInProgress) {
		t.Fatalf("OpenShared with a marker = %v, want ErrRestoreInProgress", err)
	}
	p, _ := newRestorePaths(f.live)
	if err := os.Remove(p.marker); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.rollback, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenShared(f.live); !errors.Is(err, ErrRestoreInProgress) {
		t.Fatalf("OpenShared with a rollback file = %v, want ErrRestoreInProgress", err)
	}
	assertGone(t, f.live+"-wal")
}
