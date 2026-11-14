package db

import (
	"errors"
	"os"
	"runtime"
	"testing"
)

func TestRestorePending_MarkerOrRollback(t *testing.T) {
	f := newStagedFixture(t)
	if err := RestorePending(f.live); err != nil {
		t.Fatalf("nothing staged: RestorePending = %v, want nil", err)
	}
	f.stage(t)
	if err := RestorePending(f.live); !errors.Is(err, ErrRestoreInProgress) {
		t.Fatalf("staged: RestorePending = %v, want ErrRestoreInProgress", err)
	}
	if err := os.Remove(f.live + restoreMarkerSuffix); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.live+restoreRollbackSuffix, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestorePending(f.live); !errors.Is(err, ErrRestoreInProgress) {
		t.Fatalf("rollback present: RestorePending = %v, want ErrRestoreInProgress", err)
	}
}

// The staged copy takes the live database's mode, so the renamed-in file is
// as usable by the service as the one it replaces.
func TestStageRestore_StagedCopyKeepsLiveMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no Unix file modes on Windows")
	}
	f := newStagedFixture(t)
	if err := os.Chmod(f.live, 0o640); err != nil {
		t.Fatal(err)
	}
	f.stage(t)
	info, err := os.Stat(f.live + restoreStagedSuffix)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o640 {
		t.Fatalf("staged copy mode = %o, want 640", got)
	}
}

// With no live database there is nothing to match: the copy keeps its own mode.
func TestMatchLiveOwner_NoLiveDatabase(t *testing.T) {
	dir := t.TempDir()
	out, err := os.CreateTemp(dir, "staged")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close() //nolint:errcheck
	if err := matchLiveOwner(dir+"/missing.db", out); err != nil {
		t.Fatalf("matchLiveOwner with no live database = %v, want nil", err)
	}
}
