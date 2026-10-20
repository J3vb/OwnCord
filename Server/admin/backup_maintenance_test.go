package admin_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
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
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups with no settings: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 0 {
		t.Fatalf("no-settings tick created files: %v", got)
	}

	// Schedule off → still a no-op.
	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "7")
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups with schedule=off: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 0 {
		t.Fatalf("schedule=off created files: %v", got)
	}

	// Daily → first tick creates exactly one scheduled backup.
	mustSetSetting(t, database, "backup_schedule", "daily")
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups daily #1: %v", err)
	}
	files := listBackupFiles(t, dir)
	if len(files) != 1 || !strings.HasPrefix(files[0], "scheduled_") {
		t.Fatalf("after first daily tick files = %v, want one scheduled_*.db", files)
	}
	first := filepath.Join(dir, files[0])

	// Fresh backup on disk → next tick is a no-op.
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups daily #2: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 1 {
		t.Fatalf("fresh-backup tick changed files: %v", got)
	}

	// Backup older than a day (but inside retention) → a new one is taken and
	// the old one is kept.
	backdate(t, first, 25*time.Hour)
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups daily #3: %v", err)
	}
	if got := listBackupFiles(t, dir); len(got) != 2 {
		t.Fatalf("stale-backup tick files = %v, want 2", got)
	}

	// Old backup past the 7-day retention window → pruned; the fresh one stays.
	backdate(t, first, 8*24*time.Hour)
	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
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

	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	got := listBackupFiles(t, dir)
	if len(got) != 1 || got[0] != "chatserver_b.db" {
		t.Fatalf("files = %v, want only chatserver_b.db (newest kept)", got)
	}
}

// TestMaintainBackups_RetentionKeepsPreRestoreCopies locks the safety rule:
// the pre_restore_* copies written before an admin restore are not retention
// history and survive pruning even when they are older than the window.
func TestMaintainBackups_RetentionKeepsPreRestoreCopies(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	ctx := context.Background()

	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "7")

	ancientManual := filepath.Join(dir, "chatserver_a.db")
	ancientSafety := filepath.Join(dir, "pre_restore_20200101_000000.db")
	newest := filepath.Join(dir, "chatserver_b.db")
	for _, p := range []string{ancientManual, ancientSafety, newest} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, ancientManual, 400*24*time.Hour)
	backdate(t, ancientSafety, 400*24*time.Hour)
	backdate(t, newest, time.Hour)

	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	got := listBackupFiles(t, dir)
	want := map[string]bool{"pre_restore_20200101_000000.db": true, "chatserver_b.db": true}
	if len(got) != len(want) {
		t.Fatalf("files = %v, want exactly %v (expired manual pruned, safety copy kept)", got, want)
	}
	for _, name := range got {
		if !want[name] {
			t.Errorf("unexpected surviving file %q", name)
		}
	}
}

// TestMaintainBackups_RetentionKeepsPreMigrateCopies: the boot-time
// pre_migrate_* safety copy is the rollback target for the schema move
// that was about to happen. Like the pre_restore_ copies it is not retention
// history and must survive pruning even when older than the window.
func TestMaintainBackups_RetentionKeepsPreMigrateCopies(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	ctx := context.Background()

	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "7")

	ancientManual := filepath.Join(dir, "chatserver_a.db")
	ancientSafety := filepath.Join(dir, "pre_migrate_021_voice_server_moderation.db")
	newest := filepath.Join(dir, "chatserver_b.db")
	for _, p := range []string{ancientManual, ancientSafety, newest} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, ancientManual, 400*24*time.Hour)
	backdate(t, ancientSafety, 400*24*time.Hour)
	backdate(t, newest, time.Hour)

	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	got := listBackupFiles(t, dir)
	want := map[string]bool{"pre_migrate_021_voice_server_moderation.db": true, "chatserver_b.db": true}
	if len(got) != len(want) {
		t.Fatalf("files = %v, want exactly %v (expired manual pruned, pre-migration safety copy kept)", got, want)
	}
	for _, name := range got {
		if !want[name] {
			t.Errorf("unexpected surviving file %q", name)
		}
	}
}

// TestMaintainBackups_OutOfRangeRetentionPrunesNothing is OC-0393's second
// instance: pruneExpiredBackups builds its cutoff with the identical
// now.Add(-days*24h) arithmetic as the message-retention sweep, and
// backup_retention is on the admin PATCH whitelist with no numeric
// validation at all — unlike retention_days, this one is reachable today by
// an admin typing an extra digit. Past the overflow boundary the cutoff
// lands in the future and every backup but the newest would be unlinked;
// it must instead disable pruning, the same as the existing days<=0 case.
func TestMaintainBackups_OutOfRangeRetentionPrunesNothing(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	ctx := context.Background()

	mustSetSetting(t, database, "backup_schedule", "off")
	mustSetSetting(t, database, "backup_retention", "106752")

	older := filepath.Join(dir, "chatserver_a.db")
	newer := filepath.Join(dir, "chatserver_b.db")
	for _, p := range []string{older, newer} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, older, 400*24*time.Hour)
	backdate(t, newer, 200*24*time.Hour)

	if err := admin.MaintainBackups(ctx, database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	got := listBackupFiles(t, dir)
	if len(got) != 2 {
		t.Fatalf("files = %v, want both kept (an out-of-range retention window must disable pruning, not overflow into the future)", got)
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

// TestMaintainBackups_RemovesStaleBackupTemps: a backup killed mid-VACUUM
// leaves a ".tmp" and SQLite's ".tmp-journal" sidecar, which no *.db scan
// ever reclaims. The tick removes those untouched for longer than the
// shortest schedule interval and leaves a fresh one — a backup that may still
// be writing it — alone, whatever the schedule.
func TestMaintainBackups_RemovesStaleBackupTemps(t *testing.T) {
	database := openAdminTestDB(t)
	dir := t.TempDir()
	admin.SetBackupBaseDir(dir)
	t.Cleanup(func() { admin.SetBackupBaseDir(filepath.Join("data", "backups")) })
	mustSetSetting(t, database, "backup_schedule", "off")

	stale := filepath.Join(dir, "scheduled_20260101_000000.db.123.tmp")
	staleJournal := stale + "-journal"
	fresh := filepath.Join(dir, "chatserver_20260101_000000.db.456.tmp")
	for _, p := range []string{stale, staleJournal, fresh} {
		if err := os.WriteFile(p, []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	staleArchive := filepath.Join(dir, "owncord-archive-123")
	freshArchive := filepath.Join(dir, "owncord-archive-456")
	for _, d := range []string{staleArchive, freshArchive} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(d, "snapshot.db"), []byte("partial"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	backdate(t, stale, 25*time.Hour)
	backdate(t, staleJournal, 25*time.Hour)
	backdate(t, staleArchive, 25*time.Hour)

	if err := admin.MaintainBackups(context.Background(), database, service.NewSettingsService(database)); err != nil {
		t.Fatalf("MaintainBackups: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("a stale backup temp survived the tick (stat err=%v)", err)
	}
	if _, err := os.Stat(staleJournal); !os.IsNotExist(err) {
		t.Fatalf("a stale backup temp's journal survived the tick (stat err=%v)", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("the tick removed a backup temp that may still be written: %v", err)
	}
	if _, err := os.Stat(staleArchive); !os.IsNotExist(err) {
		t.Fatalf("a stale archive work dir survived the tick (stat err=%v)", err)
	}
	if _, err := os.Stat(freshArchive); err != nil {
		t.Fatalf("the tick removed an archive work dir that may still be building: %v", err)
	}
}

// writeSafetyFixture writes name in dir and stamps its mtime age ago.
func writeSafetyFixture(t *testing.T, dir, name string, age time.Duration) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	backdate(t, p, age)
}

// TestPruneSafetyCopies_KeepsNewestPerPrefix: each prefix keeps its newest 3 by
// mtime (not by name: _10 sorts before _2), and nothing else is touched.
func TestPruneSafetyCopies_KeepsNewestPerPrefix(t *testing.T) {
	dir := t.TempDir()
	// Age order, newest first, deliberately disagreeing with name order.
	restore := []string{"pre_restore_20260101_000001.db", "pre_restore_20260101_000009.db", "pre_restore_20250101_000000.db", "pre_restore_20270101_000000.db", "pre_restore_20240101_000000.db"}
	migrate := []string{"pre_migrate_021_x_2.db", "pre_migrate_021_x_10.db", "pre_migrate_021_x.db", "pre_migrate_021_x_3.db", "pre_migrate_021_x_11.db"}
	for i, n := range restore {
		writeSafetyFixture(t, dir, n, time.Duration(i+1)*time.Hour)
	}
	for i, n := range migrate {
		writeSafetyFixture(t, dir, n, time.Duration(i+1)*time.Hour)
	}
	writeSafetyFixture(t, dir, "scheduled_20200101_000000.db", 900*time.Hour)
	writeSafetyFixture(t, dir, "chatserver_20200101_000000.db", 900*time.Hour)

	removed, err := admin.PruneSafetyCopies(dir, admin.SafetyCopiesKept)
	if err != nil {
		t.Fatalf("PruneSafetyCopies: %v", err)
	}
	if len(removed) != 4 {
		t.Fatalf("removed = %v, want 4 names", removed)
	}
	got := map[string]bool{}
	for _, n := range listBackupFiles(t, dir) {
		got[n] = true
	}
	want := append(append([]string{}, restore[:3]...), migrate[:3]...)
	want = append(want, "scheduled_20200101_000000.db", "chatserver_20200101_000000.db")
	if len(got) != len(want) {
		t.Fatalf("files = %v, want %v", got, want)
	}
	for _, n := range want {
		if !got[n] {
			t.Errorf("%s was removed, want kept", n)
		}
	}
}

// TestPruneSafetyCopies_ProtectedAndEdgeInputs: protected paths survive, a
// missing directory is not an error, and keep < 1 behaves as 1.
func TestPruneSafetyCopies_ProtectedAndEdgeInputs(t *testing.T) {
	if removed, err := admin.PruneSafetyCopies(filepath.Join(t.TempDir(), "absent"), 3); removed != nil || err != nil {
		t.Fatalf("missing dir = %v, %v; want nil, nil", removed, err)
	}
	dir := t.TempDir()
	writeSafetyFixture(t, dir, "pre_restore_a.db", 1*time.Hour)
	writeSafetyFixture(t, dir, "pre_restore_b.db", 2*time.Hour)
	writeSafetyFixture(t, dir, "pre_restore_c.db", 3*time.Hour)
	removed, err := admin.PruneSafetyCopies(dir, 0, filepath.Join(dir, ".", "pre_restore_c.db"))
	if err != nil {
		t.Fatalf("PruneSafetyCopies: %v", err)
	}
	if len(removed) != 1 || removed[0] != "pre_restore_b.db" {
		t.Fatalf("removed = %v, want only pre_restore_b.db (a newest, c protected)", removed)
	}
}

// TestPruneSafetyCopies_RemoveErrorIsJoinedNotFatal: a failed removal is
// reported but does not stop the other removals.
func TestPruneSafetyCopies_RemoveErrorIsJoinedNotFatal(t *testing.T) {
	dir := t.TempDir()
	for i, n := range []string{"pre_restore_1.db", "pre_restore_2.db", "pre_restore_3.db", "pre_restore_4.db", "pre_restore_5.db"} {
		writeSafetyFixture(t, dir, n, time.Duration(i+1)*time.Hour)
	}
	boom := errors.New("boom")
	defer admin.SetRemoveSafetyCopyForTest(func(p string) error {
		if filepath.Base(p) == "pre_restore_4.db" {
			return boom
		}
		return os.Remove(p)
	})()
	removed, err := admin.PruneSafetyCopies(dir, 3)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want it to wrap the removal error", err)
	}
	if len(removed) != 1 || removed[0] != "pre_restore_5.db" {
		t.Fatalf("removed = %v, want the other excess copy still removed", removed)
	}
}

// TestPruneSafetyCopies_ProtectsThroughSymlink: a protect path spelled through
// a symlink names the same file and must survive.
func TestPruneSafetyCopies_ProtectsThroughSymlink(t *testing.T) {
	dir := t.TempDir()
	writeSafetyFixture(t, dir, "pre_restore_a.db", 1*time.Hour)
	writeSafetyFixture(t, dir, "pre_restore_b.db", 2*time.Hour)
	writeSafetyFixture(t, dir, "pre_restore_c.db", 3*time.Hour)
	writeSafetyFixture(t, dir, "pre_restore_d.db", 4*time.Hour)
	link := filepath.Join(t.TempDir(), "link.db")
	if err := os.Symlink(filepath.Join(dir, "pre_restore_d.db"), link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	removed, err := admin.PruneSafetyCopies(dir, 3, link)
	if err != nil {
		t.Fatalf("PruneSafetyCopies: %v", err)
	}
	if len(removed) != 0 {
		t.Fatalf("removed = %v, want nothing (the only excess copy is protected via symlink)", removed)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "pre_restore_d.db")); statErr != nil {
		t.Fatalf("protected file is gone: %v", statErr)
	}
}
