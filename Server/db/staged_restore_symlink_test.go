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
	assertGone(t, real+restoreRollbackSuffix, real+restoreMarkerSuffix, link+restoreRollbackSuffix)
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
