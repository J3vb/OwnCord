package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/internal/alphasnap"
)

var retentionNow = time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC)

// seedRetentionChannel creates a channel with old and fresh messages, each
// old one carrying an attachment whose file exists in dir.
func seedRetentionChannel(t *testing.T, database *db.DB, name string, uid int64, dir string, old int) (int64, []string) {
	t.Helper()
	ctx := context.Background()
	chID, err := database.CreateChannel(ctx, name, "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]string, 0, old)
	for i := range old {
		res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, ?, ?)`,
			chID, uid, fmt.Sprintf("old %d", i), retentionNow.Add(-time.Duration(30+i)*24*time.Hour).Format("2006-01-02 15:04:05"))
		if err != nil {
			t.Fatal(err)
		}
		mid, _ := res.LastInsertId()
		stored := fmt.Sprintf("%s-old-%d", name, i)
		if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES (?, ?, 'f', ?, 'image/png', 1, ?)`,
			stored, mid, stored, uid); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, stored), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		files = append(files, stored)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, 'fresh', ?)`,
		chID, uid, retentionNow.Add(-time.Hour).Format("2006-01-02 15:04:05")); err != nil {
		t.Fatal(err)
	}
	return chID, files
}

func countMessages(t *testing.T, database *db.DB, chID int64) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, chID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func newRetention(t *testing.T, database *db.DB, dir string) *RetentionService {
	t.Helper()
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(newTestMarkers(t))
	svc.SetClock(func() time.Time { return retentionNow })
	return svc
}

// Indefinite by default: with no policy a tick removes nothing, on a fresh
// server and on the alpha snapshot (the upgraded-server case).
func TestRetention_IndefiniteByDefault(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "default-chan", uid, dir, 3)
	svc := newRetention(t, database, dir)
	rep, err := svc.Tick(ctx)
	if err != nil || rep.Messages != 0 || rep.Channels != 0 {
		t.Fatalf("Tick with no policy = %+v, %v; want nothing", rep, err)
	}
	if countMessages(t, database, chID) != 4 || !fileExists(t, filepath.Join(dir, files[0])) {
		t.Fatal("the default policy deleted something")
	}

	path, err := alphasnap.Copy(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	alpha, err := db.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = alpha.Close() })
	if err := db.Migrate(alpha); err != nil {
		t.Fatal(err)
	}
	var before int
	_ = alpha.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&before)
	upgraded := NewRetentionService(alpha)
	rep, err = upgraded.Tick(ctx)
	if err != nil || rep.Messages != 0 {
		t.Fatalf("Tick on the upgraded snapshot = %+v, %v; want nothing", rep, err)
	}
	var after int
	_ = alpha.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&after)
	if after != before || before != 20000 {
		t.Errorf("messages on the alpha copy %d -> %d, want 20000 untouched", before, after)
	}
	if p, err := upgraded.Preview(ctx); err != nil || len(p) != 0 {
		t.Errorf("preview with no policy = %v, %v", p, err)
	}
}

// The sweep: a server window, a channel opting out, a channel shorter than
// the server, pinned and DM content untouched, files removed, a marker per
// swept channel, and the effect preview matching what the tick removes.
func TestRetention_TickAppliesTheEffectivePolicy(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	other, _ := database.CreateUser(ctx, "ret-other", "hash", 4)
	general, generalFiles := seedRetentionChannel(t, database, "general", uid, dir, 3) // 30..32 days old
	forever, foreverFiles := seedRetentionChannel(t, database, "forever", uid, dir, 2) // opts out
	short, shortFiles := seedRetentionChannel(t, database, "short", uid, dir, 2)       // 30, 31 days old
	dm, _, err := database.GetOrCreateDMChannel(ctx, uid, other)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, 'old dm', ?)`,
		dm.ID, uid, retentionNow.Add(-400*24*time.Hour).Format("2006-01-02 15:04:05")); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE messages SET pinned = 1 WHERE channel_id = ? AND content = 'old 0'`, general); err != nil {
		t.Fatal(err)
	}
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "31"}); err != nil {
		t.Fatal(err)
	}
	svc := newRetention(t, database, dir)
	if _, err := svc.SetChannelPolicy(ctx, uid, forever, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetChannelPolicy(ctx, uid, short, 7); err != nil {
		t.Fatal(err)
	}

	preview, err := svc.Preview(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[int64]int64{general: 1, short: 2} // general: 32-day-old only (31 exactly is at the boundary, 30 inside, "old 0" pinned)
	for _, p := range preview {
		if p.WouldDelete != want[p.ChannelID] {
			t.Errorf("preview %s would delete %d, want %d", p.ChannelName, p.WouldDelete, want[p.ChannelID])
		}
		delete(want, p.ChannelID)
	}
	if len(want) != 0 {
		t.Errorf("channels missing from the preview: %v", want)
	}

	rep, err := svc.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	if rep.Channels != 2 || rep.Messages != 3 || rep.FilesRemoved != 3 || rep.Budgeted {
		t.Errorf("report = %+v, want 2 channels, 3 messages, 3 files", rep)
	}
	if countMessages(t, database, general) != 3 { // pinned old 0, old 1 (30d), fresh
		t.Errorf("general messages = %d, want 3", countMessages(t, database, general))
	}
	if countMessages(t, database, forever) != 3 || countMessages(t, database, dm.ID) != 1 {
		t.Error("an opted-out channel or a DM lost messages")
	}
	if countMessages(t, database, short) != 1 {
		t.Errorf("short messages = %d, want 1 (fresh)", countMessages(t, database, short))
	}
	if fileExists(t, filepath.Join(dir, generalFiles[2])) || fileExists(t, filepath.Join(dir, shortFiles[0])) || fileExists(t, filepath.Join(dir, shortFiles[1])) {
		t.Error("a removed message's file is still on disk")
	}
	if !fileExists(t, filepath.Join(dir, generalFiles[0])) || !fileExists(t, filepath.Join(dir, foreverFiles[0])) {
		t.Error("a kept message's file was removed")
	}
	markers, _ := svc.markers.Markers(ctx)
	if len(markers) != 2 {
		t.Errorf("markers after the sweep = %+v, want one per swept channel", markers)
	}
	// Audit: the two channel policy changes, old -> new.
	var n int
	_ = database.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_log WHERE action = 'channel_retention_change' AND actor_id = ?`, uid).Scan(&n)
	if n != 2 {
		t.Errorf("channel_retention_change rows = %d, want 2", n)
	}
	// A second tick finds nothing.
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 0 {
		t.Errorf("second Tick = %+v, %v", rep, err)
	}
	// Policy edge cases.
	if _, err := svc.SetChannelPolicy(ctx, uid, dm.ID, 3); !errors.Is(err, ErrBadRequest) {
		t.Errorf("policy on a DM = %v, want ErrBadRequest", err)
	}
	if _, err := svc.SetChannelPolicy(ctx, uid, general, RetentionMaxDays+1); !errors.Is(err, ErrBadRequest) {
		t.Errorf("policy above the max = %v", err)
	}
	if _, err := svc.SetChannelPolicy(ctx, uid, 999999, 3); !errors.Is(err, ErrNotFound) {
		t.Errorf("policy on a missing channel = %v", err)
	}
	if err := svc.ClearChannelPolicy(ctx, uid, general); !errors.Is(err, ErrNotFound) {
		t.Errorf("clearing a channel without an override = %v", err)
	}
	if err := svc.ClearChannelPolicy(ctx, uid, short); err != nil {
		t.Errorf("ClearChannelPolicy: %v", err)
	}
	policy, err := svc.Policy(ctx)
	if err != nil || policy.ServerDays != 31 || len(policy.Channels) != 1 || policy.Channels[0].ChannelID != forever {
		t.Errorf("policy = %+v, %v", policy, err)
	}
}

// The tick is bounded and restart-safe: a budget stops it mid-channel with
// no marker written for that channel, the next tick continues; a run whose
// files were never removed is resumed on the next tick.
func TestRetention_BudgetAndResume(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "budget", uid, dir, 4)
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}); err != nil {
		t.Fatal(err)
	}

	// The database half only, as a crash after commit leaves it: the run
	// is journaled with its files, none removed.
	runID, _ := database.StartRetentionRun(ctx)
	n, swept, err := database.SweepRetention(ctx, chID, retentionNow.Add(-7*24*time.Hour), 2)
	if err != nil || n != 2 {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunFiles(ctx, runID, 1, 2, swept); err != nil {
		t.Fatal(err)
	}
	for _, f := range swept {
		if !fileExists(t, filepath.Join(dir, f)) {
			t.Fatalf("%s should still be on disk", f)
		}
	}

	svc := newRetention(t, database, dir)
	rep, err := svc.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	for _, f := range swept {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s not removed by the resume", f)
		}
	}
	if rep.Messages != 2 || rep.FilesRemoved != 2 {
		t.Errorf("report = %+v, want the remaining 2 messages and files", rep)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("unfinished runs after the tick: %+v", runs)
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk", f)
		}
	}
	if countMessages(t, database, chID) != 1 {
		t.Errorf("messages = %d, want the fresh one", countMessages(t, database, chID))
	}
	// A failing remover records the attempt and the run stays for resume.
	remover := &failingRemover{real: newTestStorage(t, dir)}
	svc2 := newRetention(t, database, dir)
	svc2.SetFiles(remover)
	if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, 'old again', ?)`,
		chID, uid, retentionNow.Add(-40*24*time.Hour).Format("2006-01-02 15:04:05")); err != nil {
		t.Fatal(err)
	}
	var mid int64
	_ = database.QueryRowContext(ctx, `SELECT id FROM messages WHERE content = 'old again'`).Scan(&mid)
	if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES ('again', ?, 'f', 'stored-again', 'image/png', 1, ?)`, mid, uid); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "stored-again"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := svc2.Tick(ctx); err == nil {
		t.Fatal("Tick with a failing remover reported success")
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 1 || runs[0].LastError == "" {
		t.Fatalf("unfinished runs after the failure = %+v", runs)
	}
	remover.allow = true
	if _, err := svc2.Tick(ctx); err != nil {
		t.Fatalf("Tick after the remover recovers: %v", err)
	}
	if fileExists(t, filepath.Join(dir, "stored-again")) {
		t.Error("the journaled file survived the resume")
	}
}

// The restore interplay (HP-4 decision 6): a restored backup holding
// messages older than a channel's recorded cutoff loses them again on
// ReplayMarkers, files included.
func TestRetention_ReplayMarkersResweepsARestoredBackup(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database, err := db.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "restored", uid, dir, 3)
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "older.db")
	if err := database.BackupToSafe(ctx, backup, filepath.Dir(backup)); err != nil {
		t.Fatal(err)
	}
	markers := newTestMarkers(t)
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 3 {
		t.Fatalf("Tick = %+v, %v", rep, err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(backup)
	if err := os.WriteFile(dbPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(dir, f), []byte("back"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	restored, err := db.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = restored.Close() })
	if err := db.Migrate(restored); err != nil {
		t.Fatal(err)
	}
	if countMessages(t, restored, chID) != 4 {
		t.Fatal("the restore did not resurrect the messages")
	}
	fresh := NewRetentionService(restored)
	fresh.SetFiles(newTestStorage(t, dir))
	if n, err := fresh.ReplayMarkers(ctx); err != nil || n != 0 {
		t.Fatalf("ReplayMarkers without markers = %d, %v", n, err)
	}
	fresh.SetMarkers(markers)
	n, err := fresh.ReplayMarkers(ctx)
	if err != nil || n != 3 {
		t.Fatalf("ReplayMarkers = %d, %v; want 3 messages removed again", n, err)
	}
	if countMessages(t, restored, chID) != 1 {
		t.Errorf("messages after the replay = %d, want 1", countMessages(t, restored, chID))
	}
	for _, f := range files {
		if fileExists(t, filepath.Join(dir, f)) {
			t.Errorf("%s still on disk after the replayed sweep", f)
		}
	}
	if runs, _ := restored.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("the replay left an unfinished run: %+v", runs)
	}
}

func TestSettings_RetentionDaysValidatedAndAudited(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "settings-owner", "hash", 1)
	svc := NewSettingsService(database)
	for _, bad := range []string{"-1", "0.5", "days", "99999"} {
		if _, err := svc.Patch(ctx, uid, map[string]string{db.RetentionDaysKey: bad}); !errors.Is(err, ErrBadRequest) {
			t.Errorf("retention_days=%q accepted: %v", bad, err)
		}
	}
	if _, err := svc.Patch(ctx, uid, map[string]string{db.RetentionDaysKey: " 14 "}); err != nil {
		t.Fatalf("retention_days=14: %v", err)
	}
	if days, _ := database.ServerRetentionDays(ctx); days != 14 {
		t.Errorf("stored days = %d, want 14", days)
	}
	if _, err := svc.Patch(ctx, uid, map[string]string{db.RetentionDaysKey: "0"}); err != nil {
		t.Fatalf("retention_days=0: %v", err)
	}
	var detail string
	_ = database.QueryRowContext(ctx, `SELECT detail FROM audit_log WHERE action = 'retention_policy_change' ORDER BY id DESC LIMIT 1`).Scan(&detail)
	if detail != "retention_days 14 -> 0" {
		t.Errorf("audit detail = %q, want old -> new", detail)
	}
	_ = auth.NewRateLimiter()
}
