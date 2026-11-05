package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestReserve_NotBlockedByAConcurrentBackup is PERF-10's service-level proof.
// An upload's charge is writer I/O made under the quota mutex, so a backup
// holding the single writer used to stall every upload admission for the
// backup's whole duration. SRV-02 moved the backup to the reader pool, which
// is what satisfies PERF-10.
//
// Deterministic, no sleep and no wall-clock ratio: db.BackupVACUUMPreExecHook
// parks the backup at its VACUUM, while it provably holds the connection the
// VACUUM runs on, until this test releases it. Reserve and Release must
// complete during that hold. If the pinned VACUUM connection were taken from
// the single writer, the hook would be holding that writer and Reserve would
// block here. This replaces the old "Reserve+Release took a quarter of the
// backup's time" comparison, which broke under parallel package load. It does
// not overlap Reserve with a running VACUUM; the db-level
// TestBackupToSafe_ConcurrentWriteIsNotDelayed, which uses the same seam, does
// not either — both prove the backup does not hold the writer.
func TestReserve_NotBlockedByAConcurrentBackup(t *testing.T) {
	dir := t.TempDir()
	database, err := db.Open(filepath.Join(dir, "quota.db"))
	mustDo(t, "db.Open", err)
	t.Cleanup(func() { _ = database.Close() })
	mustDo(t, "db.Migrate", db.Migrate(database))
	seedUser(t, database, &db.User{ID: quotaTestUser, Username: "quota_user", RoleID: 4})
	svc := NewUploadService(database, NewPermissionService(database, permissions.NewChecker(database)))
	svc.SetStorageLimits(StorageLimits{Dir: t.TempDir(), FreeBytes: func(string) (uint64, error) {
		return 0, errors.New("no statfs in tests")
	}})
	ctx := context.Background()

	backupDir := filepath.Join(dir, "backups")
	mustDo(t, "MkdirAll", os.MkdirAll(backupDir, 0o750))

	parked, releaseBackup := parkBackupVACUUM(t)

	done := make(chan error, 1)
	go func() {
		done <- database.BackupToSafe(ctx, filepath.Join(backupDir, "during-uploads.db"), backupDir)
	}()

	select {
	case <-parked:
	case err := <-done:
		t.Fatalf("BackupToSafe returned before reaching its VACUUM: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("backup never reached its VACUUM; the test exercised nothing")
	}

	// Reserve and Release while the backup is provably parked inside it.
	reserveDone := make(chan error, 1)
	go func() {
		res, err := svc.Reserve(ctx, quotaTestUser, 100)
		if err != nil {
			reserveDone <- err
			return
		}
		res.Release(ctx)
		reserveDone <- nil
	}()

	select {
	case err := <-reserveDone:
		mustDo(t, "Reserve during backup", err)
	case <-time.After(10 * time.Second):
		t.Fatal("Reserve did not complete while the backup was held at its VACUUM; the upload charge is queuing behind the backup")
	}

	releaseBackup()
	if backupErr := <-done; backupErr != nil {
		t.Fatalf("BackupToSafe: %v", backupErr)
	}
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after Reserve and Release, want 0", got)
	}
}

// parkBackupVACUUM parks the next backup at its VACUUM seam: parked closes
// once the backup holds its connection, and it stays blocked until
// releaseBackup is called (or the test ends).
func parkBackupVACUUM(t *testing.T) (parked chan struct{}, releaseBackup func()) {
	t.Helper()
	parked = make(chan struct{})
	var gate sync.WaitGroup
	gate.Add(1)
	var released atomic.Bool
	releaseBackup = func() {
		if released.CompareAndSwap(false, true) {
			gate.Done()
		}
	}
	t.Cleanup(func() {
		releaseBackup()
		db.BackupVACUUMPreExecHook = nil
	})
	db.BackupVACUUMPreExecHook = func() {
		close(parked)
		gate.Wait()
	}
	return parked, releaseBackup
}
