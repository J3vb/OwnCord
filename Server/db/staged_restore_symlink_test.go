package db

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// linkedFixture puts the live database on another directory and points the configured path at it.
func linkedFixture(t *testing.T) (link, real, backup string) {
	t.Helper()
	cfgDir, diskDir := t.TempDir(), t.TempDir()
	real = filepath.Join(diskDir, "real.db")
	link = filepath.Join(cfgDir, "chat.db")
	backup = filepath.Join(cfgDir, "backup.db")
	writeTestDB(t, real, "live")
	writeTestDB(t, backup, "backup")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	return link, real, backup
}

func assertStillLink(t *testing.T, link, real string) {
	t.Helper()
	if info, err := os.Lstat(link); err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("%s is no longer a symlink (%v)", link, err)
	}
	if got, err := os.Readlink(link); err != nil || got != real {
		t.Fatalf("link points at %q (%v), want %q", got, err, real)
	}
}

func TestStageRestore_ThroughSymlinkKeepsLinkAndFloor(t *testing.T) {
	link, real, backup := linkedFixture(t)
	if err := writeWSSeqFloorFile(real+wsSeqFloorSuffix, 4_000_000_000); err != nil {
		t.Fatal(err)
	}
	if err := CarryWSSeqFloorForRestore(context.Background(), link); err != nil {
		t.Logf("carry: %v", err)
	}
	if err := StageRestore(context.Background(), link, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
		t.Fatal(err)
	}
	// Everything is staged beside the real file; nothing lands next to the link.
	assertGone(t, link+restoreMarkerSuffix, link+restoreStagedSuffix, link+restoreStagedSuffix+".tmp")
	if !fileExists(real+restoreMarkerSuffix) || !fileExists(real+restoreStagedSuffix) {
		t.Fatal("restore files are not beside the real database")
	}
	if err := RestorePending(link); err == nil {
		t.Fatal("RestorePending missed the marker beside the real database")
	}

	d, err := Open(link)
	if err != nil {
		t.Fatal(err)
	}
	if floor, ok, err := d.WSSeqFloorSidecar(); err != nil || !ok || floor != 4_000_000_000 {
		t.Fatalf("floor after restore = %d ok=%v err=%v", floor, ok, err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}

	assertStillLink(t, link, real)
	assertRows(t, real, "backup")
	assertGone(t, real+restoreMarkerSuffix, real+restoreStagedSuffix, real+restoreRollbackSuffix,
		real+restoreRollbackSuffix+"-wal", real+restoreRollbackSuffix+"-shm",
		link+restoreRollbackSuffix, link+restoreMarkerSuffix)
	if res, found, err := TakeRestoreResult(link); err != nil || !found || res.Status != RestoreStatusApplied {
		t.Fatalf("result = %+v, %v, %v", res, found, err)
	}
}

func TestApplyStagedRestore_RollbackThroughSymlinkKeepsLink(t *testing.T) {
	link, real, backup := linkedFixture(t)
	if err := StageRestore(context.Background(), link, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
		t.Fatal(err)
	}
	prev := checkSwapped
	checkSwapped = func(context.Context, string) error { return os.ErrInvalid }
	t.Cleanup(func() { checkSwapped = prev })

	res, err := ApplyStagedRestore(link)
	if err != nil || res.Status != RestoreStatusRolledBack {
		t.Fatalf("apply = %+v, %v; want rolled_back", res, err)
	}
	assertStillLink(t, link, real)
	assertRows(t, real, "live")
	assertGone(t, real+restoreRollbackSuffix, real+restoreMarkerSuffix, link+restoreRollbackSuffix, link+restoreResultSuffix)
	if !fileExists(real + restoreResultSuffix) {
		t.Fatal("the result file is not beside the real database")
	}
	entries, err := os.ReadDir(filepath.Dir(link))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if n := e.Name(); n != "chat.db" && n != "backup.db" && n != "chat.db.message-retry-floor" {
			t.Errorf("unexpected file beside the link: %s", n)
		}
	}
}

func TestApplyStagedRestore_SymlinkResumesAfterCrash(t *testing.T) {
	for _, step := range []string{"aside-main", "aside"} {
		t.Run(step, func(t *testing.T) {
			link, real, backup := linkedFixture(t)
			if err := StageRestore(context.Background(), link, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
				t.Fatal(err)
			}
			crashAt(t, step)
			if _, err := ApplyStagedRestore(link); err == nil {
				t.Fatal("expected the simulated crash")
			}
			if fileExists(real) {
				t.Fatal("expected the live file moved aside")
			}
			if err := RestorePending(link); err == nil {
				t.Fatal("RestorePending missed the half-swapped restore")
			}
			noCrash(t)
			res, err := ApplyStagedRestore(link)
			if err != nil || res.Status != RestoreStatusApplied {
				t.Fatalf("resume = %+v, %v", res, err)
			}
			assertStillLink(t, link, real)
			assertRows(t, real, "backup")
			assertGone(t, real+restoreMarkerSuffix, real+restoreStagedSuffix, real+restoreRollbackSuffix, link+restoreRollbackSuffix)
		})
	}
}

func TestApplyStagedRestore_SymlinkResumesInterruptedRollback(t *testing.T) {
	link, real, backup := linkedFixture(t)
	if err := StageRestore(context.Background(), link, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
		t.Fatal(err)
	}
	prev := checkSwapped
	checkSwapped = func(context.Context, string) error { return os.ErrInvalid }
	t.Cleanup(func() { checkSwapped = prev })
	crashAt(t, "swapped")
	if _, err := ApplyStagedRestore(link); err == nil {
		t.Fatal("expected the simulated crash")
	}
	// Killed inside the rollback, after the restored main file was removed.
	if err := removeAll(real); err != nil {
		t.Fatal(err)
	}
	if err := RestorePending(link); err == nil {
		t.Fatal("RestorePending missed the interrupted rollback")
	}
	noCrash(t)
	res, err := ApplyStagedRestore(link)
	if err != nil || res.Status != RestoreStatusRolledBack {
		t.Fatalf("resume = %+v, %v", res, err)
	}
	assertStillLink(t, link, real)
	assertRows(t, real, "live")
	assertGone(t, real+restoreRollbackSuffix, real+restoreMarkerSuffix)
}

func TestApplyStagedRestore_FinishesRestoreStagedBesideLink(t *testing.T) {
	link, real, backup := linkedFixture(t)
	// An older binary staged beside the link path itself.
	if err := os.Rename(backup, link+restoreStagedSuffix); err != nil {
		t.Fatal(err)
	}
	sum, err := fileSHA256(link + restoreStagedSuffix)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte(`{"backup":"backup.db","sha256":"` + sum + `"}`)
	if err := os.WriteFile(link+restoreMarkerSuffix, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestorePending(link); err == nil {
		t.Fatal("RestorePending missed the legacy marker")
	}
	res, err := ApplyStagedRestore(link)
	if err != nil || res.Status != RestoreStatusApplied {
		t.Fatalf("apply = %+v, %v", res, err)
	}
	assertRows(t, link, "backup")
	assertGone(t, link+restoreMarkerSuffix, link+restoreStagedSuffix, link+restoreRollbackSuffix)
	assertRows(t, real, "live")
}

func TestApplyStagedRestore_SymlinkResumesThroughRelativeTargetInLinkedDir(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "x", "y"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "x", "disk"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(root, "cfg")
	if err := os.Symlink(filepath.Join(root, "x", "y"), cfg); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	real := filepath.Join(root, "x", "disk", "real.db")
	link := filepath.Join(cfg, "chat.db")
	backup := filepath.Join(root, "backup.db")
	writeTestDB(t, real, "live")
	writeTestDB(t, backup, "backup")
	target := filepath.Join("..", "disk", "real.db")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := StageRestore(context.Background(), link, backup, StagedRestoreMarker{Backup: "backup.db"}); err != nil {
		t.Fatal(err)
	}
	crashAt(t, "aside")
	if _, err := ApplyStagedRestore(link); err == nil {
		t.Fatal("expected the simulated crash")
	}
	noCrash(t)
	res, err := ApplyStagedRestore(link)
	if err != nil || res.Status != RestoreStatusApplied {
		t.Fatalf("resume = %+v, %v", res, err)
	}
	assertStillLink(t, link, target)
	assertRows(t, real, "backup")
}
