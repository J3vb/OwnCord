package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// TestReserve_NotBlockedByAConcurrentBackup is PERF-10's service-level proof.
// An upload's charge is writer I/O made under the quota mutex, so a backup
// holding the single writer used to stall every upload admission for the
// backup's whole duration. SRV-02 moved the backup to the reader pool, which
// is what satisfies PERF-10: a Reserve and a Release issued while a real
// file-backed backup runs finish in a small fraction of the backup's time.
// The comparison is against the backup's own duration, as in
// TestBackupToSafe_ConcurrentWriteIsNotDelayed, so a slow or fast box does not
// decide the result.
func TestReserve_NotBlockedByAConcurrentBackup(t *testing.T) {
	dir := t.TempDir()
	database, err := db.Open(filepath.Join(dir, "quota.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	seedUser(t, database, &db.User{ID: quotaTestUser, Username: "quota_user", RoleID: 4})
	svc := NewUploadService(database, NewPermissionService(database, permissions.NewChecker(database)))
	svc.SetStorageLimits(StorageLimits{Dir: t.TempDir(), FreeBytes: func(string) (uint64, error) {
		return 0, errors.New("no statfs in tests")
	}})
	ctx := context.Background()

	// Large enough that the backup is clearly the long pole.
	if _, err := database.ExecContext(ctx, `CREATE TABLE bulk (v TEXT)`); err != nil {
		t.Fatalf("create bulk table: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 400000)
		 INSERT INTO bulk (v) SELECT 'seed ' || i || ' xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' FROM seq`); err != nil {
		t.Fatalf("seed rows: %v", err)
	}

	backupDir := filepath.Join(dir, "backups")
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	backupStart := time.Now()
	done := make(chan error, 1)
	go func() {
		done <- database.BackupToSafe(ctx, filepath.Join(backupDir, "during-uploads.db"), backupDir)
	}()
	// Let the backup reach its VACUUM so the upload lands inside it.
	time.Sleep(50 * time.Millisecond)

	uploadStart := time.Now()
	res, err := svc.Reserve(ctx, quotaTestUser, 100)
	if err != nil {
		t.Fatalf("Reserve during backup: %v", err)
	}
	res.Release(ctx)
	uploadLatency := time.Since(uploadStart)

	backupErr := <-done
	backupDuration := time.Since(backupStart)
	if backupErr != nil {
		t.Fatalf("BackupToSafe: %v", backupErr)
	}
	if got := used(t, svc, quotaTestUser); got != 0 {
		t.Fatalf("counter = %d after Reserve and Release, want 0", got)
	}
	if backupDuration < 100*time.Millisecond {
		t.Skipf("backup too fast (%v) to measure contention on this box", backupDuration)
	}
	if uploadLatency > backupDuration/4 {
		t.Fatalf("Reserve+Release during backup took %v against a backup of %v; the upload charge is queuing behind the backup", uploadLatency, backupDuration)
	}
}
