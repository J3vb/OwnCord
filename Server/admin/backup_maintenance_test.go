package admin_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

func listBackupFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("ReadDir: %v", err)
	}
	var names []string
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".db" {
			names = append(names, e.Name())
		}
	}
	return names
}

func backdate(t *testing.T, path string, age time.Duration) {
	t.Helper()
	old := time.Now().Add(-age)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatalf("Chtimes: %v", err)
	}
}

// TestMaintainBackups_ScheduleAndRetention exercises the full settings-driven
// lifecycle: off is a no-op, daily creates one backup and only one, staleness
// triggers the next, and retention prunes expired backups while always
// keeping the newest.
func TestMaintainBackups_ScheduleAndRetention(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	ctx := context.Background()

	// Settings absent → no-op, no error.
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups with no settings: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 0 {
		t.Fatalf("no-settings tick created files: %v", got)
	}

	// Schedule off → still a no-op.
	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "7")
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups with schedule=off: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 0 {
		t.Fatalf("schedule=off created files: %v", got)
	}

	// Daily → first tick creates exactly one scheduled backup.
	mustSetSetting(t, database, "backup_schedule", "daily")
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups daily #1: %v", err)
	}
	files := listBackupFiles(t, dir)
	if len(files) != 1 || !strings.HasPrefix(files[0], "scheduled_") {
		t.Fatalf("after first daily tick files = %v, want one scheduled_*.db", files)
	}
	first := filepath.Join(dir, files[0])

	// Fresh backup on disk → next tick is a no-op.
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups daily #2: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 1 {
		t.Fatalf("fresh-backup tick changed files: %v", got)
	}

	// Backup older than a day (but inside retention) → a new one is taken and
	// the old one is kept.
	backdate(t, first, 25*time.Hour)
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups daily #3: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 2 {
		t.Fatalf("stale-backup tick files = %v, want 2", got)
	}

	// Old backup past the 7-day retention window → pruned; the fresh one stays.
	backdate(t, first, 8*24*time.Hour)
	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups daily #4: %v", err)
	}
	got := listBackupFiles(t, dir)
	if len(got) != 1 {
		t.Fatalf("retention tick files = %v, want 1", got)
	}
	if filepath.Join(dir, got[0]) == first {
		t.Fatalf("retention pruned the newest backup instead of the expired one")
	}
}

// TestMaintainBackups_RetentionNeverDeletesNewest locks the safety rule: even
// when every backup is past retention, the newest survives.
func TestMaintainBackups_RetentionNeverDeletesNewest(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	ctx := context.Background()

	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "7")

	// Two ancient backups, one slightly newer than the other.
	older := filepath.Join(dir, "chatserver_a.db")
	newer := filepath.Join(dir, "chatserver_b.db")
	for _, p := range []string{older, newer} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, older, 30*24*time.Hour)
	backdate(t, newer, 20*24*time.Hour)

	if err := admin.MaintainBackups(ctx, database); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	got := listBackupFiles(t, dir)
	if len(got) != 1 || got[0] != "chatserver_b.db" {
		t.Fatalf("files = %v, want only chatserver_b.db (newest kept)", got)
	}
}

func mustSetSetting(t *testing.T, database interface {
	SetSetting(ctx context.Context, key, value string) error
}, key, value string,
) {
	t.Helper()
	if err := database.SetSetting(context.Background(), key, value); err != nil {
		t.Fatalf("SetSetting(%s): %v", key, err)
	}
}
