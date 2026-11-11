package service

import (
	"context"
	"database/sql"
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
	chID := mustCreateChannel(t, database, name, "text", "", "", 0)
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
		mustDo(t, "WriteFile", os.WriteFile(filepath.Join(dir, stored), []byte("x"), 0o600))
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
	mustDo(t, "QueryRowContext", database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, chID).Scan(&n))
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
	mustDo(t, "Copy", err)
	alpha, err := db.Open(path)
	mustDo(t, "Open", err)
	t.Cleanup(func() { _ = alpha.Close() })
	mustDo(t, "Migrate", db.Migrate(alpha))
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

// OC-0393: a retention_days row above RetentionMaxDays reaches Tick only
// through a hand-edited, migrated or restored row — SetChannelPolicy and
// Patch both refuse it at write time — but the read path
// (db.ServerRetentionDays -> RetentionWindows -> cutoff) must still fail
// closed. Left unclamped, days=106752 overflows the -days*24h cutoff math
// into the future and the sweep would hard-delete every unpinned message in
// every channel with a window. Clamping to RetentionMaxDays instead of
// treating it as keep-forever is just as wrong: it activates a live
// 10-year deletion window from a row that was never validated.
func TestRetention_OutOfRangeServerWindowDeletesNothing(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner-huge", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "huge-window", uid, dir, 3)
	// Bypasses the service-layer bound check the same way a corrupt row
	// would: db.ApplySettings (called directly, not through Patch) applies
	// whatever string it is given.
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "106752"}))
	svc := newRetention(t, database, dir)
	rep, err := svc.Tick(ctx)
	if err != nil || rep.Messages != 0 || rep.Channels != 0 {
		t.Fatalf("Tick with an out-of-range server window = %+v, %v; want nothing removed", rep, err)
	}
	if countMessages(t, database, chID) != 4 || !fileExists(t, filepath.Join(dir, files[0])) {
		t.Fatal("an out-of-range retention window deleted messages or files")
	}
	if p, err := svc.Preview(ctx); err != nil || len(p) != 0 {
		t.Errorf("preview with an out-of-range server window = %v, %v; want nothing", p, err)
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
	mustDo(t, "GetOrCreateDMChannel", err)
	if _, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, 'old dm', ?)`,
		dm.ID, uid, retentionNow.Add(-400*24*time.Hour).Format("2006-01-02 15:04:05")); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE messages SET pinned = 1 WHERE channel_id = ? AND content = 'old 0'`, general); err != nil {
		t.Fatal(err)
	}
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "31"}))
	svc := newRetention(t, database, dir)
	if _, err := svc.SetChannelPolicy(ctx, uid, forever, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetChannelPolicy(ctx, uid, short, 7); err != nil {
		t.Fatal(err)
	}

	preview, err := svc.Preview(ctx)
	mustDo(t, "Preview", err)
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
	mustDo(t, "Tick", err)
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
// P4-08: a retention purge removes the purged attachment's thumbnail too.
func TestRetention_PurgeRemovesThumbnails(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	_, files := seedRetentionChannel(t, database, "thumbs", uid, dir, 1)
	st := newTestStorage(t, dir)
	mustDo(t, "SaveThumb", st.SaveThumb(files[0], []byte("thumb")))
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	if rep, err := newRetention(t, database, dir).Tick(ctx); err != nil || rep.FilesRemoved != 1 {
		t.Fatalf("Tick = %+v, %v; want the old attachment removed", rep, err)
	}
	if _, err := st.OpenThumb(files[0]); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("thumbnail survived the purge: %v", err)
	}
}

func TestRetention_BudgetAndResume(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "budget", uid, dir, 4)
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))

	// The database half only, as a crash after commit leaves it: the run
	// is journaled with its files, none removed.
	runID, _ := database.StartRetentionRun(ctx)
	ids, swept, err := database.SweepRetention(ctx, chID, retentionNow.Add(-7*24*time.Hour), 2)
	if err != nil || len(ids) != 2 {
		t.Fatal(err)
	}
	mustDo(t, "RecordRetentionRunFiles", database.RecordRetentionRunFiles(ctx, runID, 1, 2, swept))
	for _, f := range swept {
		if !fileExists(t, filepath.Join(dir, f)) {
			t.Fatalf("%s should still be on disk", f)
		}
	}

	svc := newRetention(t, database, dir)
	rep, err := svc.Tick(ctx)
	mustDo(t, "Tick", err)
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
	mustDo(t, "WriteFile", os.WriteFile(filepath.Join(dir, "stored-again"), []byte("x"), 0o600))
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

// The external marker is what prevents an older backup from resurrecting a
// retention deletion. If it cannot be written, fail before deleting rows.
func TestRetention_MarkerFailureDeletesNothing(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-marker-failure", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "marker-failure", uid, dir, 1)
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	markers := newTestMarkers(t)
	mustDo(t, "Close", markers.Close())
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	rep, err := svc.Tick(ctx)
	if err == nil {
		t.Fatal("Tick with an unavailable marker store succeeded")
	}
	if rep.Messages != 0 || countMessages(t, database, chID) != 2 {
		t.Fatalf("Tick = %+v, messages left = %d; marker failure deleted data", rep, countMessages(t, database, chID))
	}
	if !fileExists(t, filepath.Join(dir, files[0])) {
		t.Fatal("marker failure removed the message's file")
	}
}

// The restore interplay (HP-4 decision 6): a restored backup holding
// messages older than a channel's recorded cutoff loses them again on
// ReplayMarkers, files included.
func TestRetention_ReplayMarkersResweepsARestoredBackup(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "main.sqlite")
	database, err := db.Open(dbPath)
	mustDo(t, "Open", err)
	mustDo(t, "Migrate", db.Migrate(database))
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, files := seedRetentionChannel(t, database, "restored", uid, dir, 3)
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	backup := filepath.Join(t.TempDir(), "older.db")
	mustDo(t, "BackupToSafe", database.BackupToSafe(ctx, backup, filepath.Dir(backup)))
	markers := newTestMarkers(t)
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 3 {
		t.Fatalf("Tick = %+v, %v", rep, err)
	}
	mustDo(t, "Close", database.Close())
	data, _ := os.ReadFile(backup)
	mustDo(t, "WriteFile", os.WriteFile(dbPath, data, 0o600))
	for _, f := range files {
		mustDo(t, "WriteFile", os.WriteFile(filepath.Join(dir, f), []byte("back"), 0o600))
	}
	restored, err := db.Open(dbPath)
	mustDo(t, "Open", err)
	t.Cleanup(func() { _ = restored.Close() })
	mustDo(t, "Migrate", db.Migrate(restored))
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

// pinnedRetentionFixture seeds a channel with three old messages and one old
// pinned message, sweeps it once under a 7-day window and returns what a later
// start-up replay needs.
func pinnedRetentionFixture(t *testing.T) (database *db.DB, dir string, markers *db.MarkerStore, chID, pinnedID int64) {
	t.Helper()
	ctx := context.Background()
	database = newTestDB(t)
	dir = t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, _ = seedRetentionChannel(t, database, "pins", uid, dir, 3)
	res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp, pinned) VALUES (?, ?, 'pinned rules', ?, 1)`,
		chID, uid, retentionNow.Add(-40*24*time.Hour).Format("2006-01-02 15:04:05"))
	mustDo(t, "insert pinned", err)
	pinnedID, _ = res.LastInsertId()
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	markers = newTestMarkers(t)
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 3 {
		t.Fatalf("Tick = %+v, %v", rep, err)
	}
	return database, dir, markers, chID, pinnedID
}

func replayAtStartup(t *testing.T, database *db.DB, dir string, markers *db.MarkerStore) int {
	t.Helper()
	fresh := NewRetentionService(database)
	fresh.SetFiles(newTestStorage(t, dir))
	fresh.SetMarkers(markers)
	n, err := fresh.ReplayMarkers(context.Background())
	mustDo(t, "ReplayMarkers", err)
	return n
}

func TestRetention_ReplayKeepsAMessageUnpinnedAfterRetentionWasTurnedOff(t *testing.T) {
	ctx := context.Background()
	database, dir, markers, chID, pinnedID := pinnedRetentionFixture(t)
	mustDo(t, "off", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "0"}))
	_, err := database.ExecContext(ctx, `UPDATE messages SET pinned = 0, pinned_at = NULL WHERE id = ?`, pinnedID)
	mustDo(t, "unpin", err)

	if n := replayAtStartup(t, database, dir, markers); n != 0 {
		t.Errorf("replay removed %d message(s) from a database that already finished the recorded sweep", n)
	}
	// The recent message and the unpinned one remain.
	if got := countMessages(t, database, chID); got != 2 {
		t.Errorf("messages after start-up = %d, want 2: the unpinned message was deleted although retention is off", got)
	}
}

func TestRetention_ReplayStillSweepsWhenTheDatabaseHasNoRecordOfTheSweep(t *testing.T) {
	ctx := context.Background()
	database, dir, markers, chID, pinnedID := pinnedRetentionFixture(t)
	// A restored older backup (or a sweep interrupted before it was recorded)
	// carries no swept record: the replay must still run.
	_, err := database.ExecContext(ctx, `DELETE FROM channel_retention_swept WHERE channel_id = ?`, chID)
	mustDo(t, "forget the finished sweep", err)
	_, err = database.ExecContext(ctx, `UPDATE messages SET pinned = 0, pinned_at = NULL WHERE id = ?`, pinnedID)
	mustDo(t, "unpin", err)

	if n := replayAtStartup(t, database, dir, markers); n != 1 {
		t.Errorf("replay removed %d message(s), want the 1 past the recorded cutoff", n)
	}
}

// fileRetentionDB opens a migrated database in a file, which a test can back
// up and restore over.
func fileRetentionDB(t *testing.T) (database *db.DB, dbPath string) {
	t.Helper()
	dbPath = filepath.Join(t.TempDir(), "main.sqlite")
	database, err := db.Open(dbPath)
	mustDo(t, "Open", err)
	mustDo(t, "Migrate", db.Migrate(database))
	return database, dbPath
}

func backUp(t *testing.T, database *db.DB, name string) string {
	t.Helper()
	backup := filepath.Join(t.TempDir(), name)
	mustDo(t, "BackupToSafe", database.BackupToSafe(context.Background(), backup, filepath.Dir(backup)))
	return backup
}

// restoreOver closes database, puts backup in its place and opens the result.
func restoreOver(t *testing.T, database *db.DB, dbPath, backup string) *db.DB {
	t.Helper()
	mustDo(t, "Close", database.Close())
	data, err := os.ReadFile(backup)
	mustDo(t, "ReadFile", err)
	mustDo(t, "WriteFile", os.WriteFile(dbPath, data, 0o600))
	restored, err := db.Open(dbPath)
	mustDo(t, "Open", err)
	t.Cleanup(func() { _ = restored.Close() })
	mustDo(t, "Migrate", db.Migrate(restored))
	return restored
}

func tickingRetention(t *testing.T, database *db.DB, dir string, markers *db.MarkerStore) *RetentionService {
	t.Helper()
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	return svc
}

// A later sweep under a longer window removes a message the first sweep left
// pinned, without moving the marker's cutoff. A backup taken between the two
// still gets the start-up replay: the marker names the second sweep and the
// backup names the first.
func TestRetention_ReplayResweepsABackupTakenBeforeASweepThatKeptTheCutoff(t *testing.T) {
	ctx := context.Background()
	database, dbPath := fileRetentionDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, _ := seedRetentionChannel(t, database, "longer", uid, dir, 3)
	res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp, pinned) VALUES (?, ?, 'pinned rules', ?, 1)`,
		chID, uid, retentionNow.Add(-40*24*time.Hour).Format("2006-01-02 15:04:05"))
	mustDo(t, "insert pinned", err)
	pinnedID, _ := res.LastInsertId()
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	markers := newTestMarkers(t)
	svc := tickingRetention(t, database, dir, markers)
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 3 {
		t.Fatalf("first Tick = %+v, %v", rep, err)
	}
	_, err = database.ExecContext(ctx, `UPDATE messages SET pinned = 0, pinned_at = NULL WHERE id = ?`, pinnedID)
	mustDo(t, "unpin", err)
	backup := backUp(t, database, "between.db")

	mustDo(t, "longer window", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "30"}))
	if rep, err := svc.Tick(ctx); err != nil || rep.Messages != 1 {
		t.Fatalf("second Tick = %+v, %v; want the unpinned 40-day-old message swept", rep, err)
	}
	restored := restoreOver(t, database, dbPath, backup)
	if countMessages(t, restored, chID) != 2 {
		t.Fatal("the restore did not bring the swept message back")
	}

	if n := replayAtStartup(t, restored, dir, markers); n != 1 {
		t.Errorf("replay removed %d message(s), want the 1 the later sweep had removed", n)
	}
	if got := countMessages(t, restored, chID); got != 1 {
		t.Errorf("messages after the replay = %d, want only the fresh one", got)
	}
	// The replayed database now names the marker's sweep: the next start leaves it alone.
	if n := replayAtStartup(t, restored, dir, markers); n != 0 {
		t.Errorf("a second start-up replay removed %d message(s), want 0", n)
	}
}

// A marker file can hold two markers for one channel, the older written under
// an erasure key since replaced. The replay decides once for the channel, so
// finishing the older marker's sweep does not make the newer one look done.
func TestRetention_ReplayRunsEveryMarkerOfAChannelOnARestoredBackup(t *testing.T) {
	ctx := context.Background()
	database, dbPath := fileRetentionDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "ret-owner", "hash", 1)
	chID, _ := seedRetentionChannel(t, database, "rekeyed", uid, dir, 3)
	mustDo(t, "ApplySettings", database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}))
	backup := backUp(t, database, "before.db")
	markers := newTestMarkers(t)
	if rep, err := tickingRetention(t, database, dir, markers).Tick(ctx); err != nil || rep.Messages != 3 {
		t.Fatalf("Tick = %+v, %v", rep, err)
	}
	// The older marker reaches only the oldest of the three messages and is replayed first.
	rawFile, err := sql.Open("sqlite", markers.Path())
	mustDo(t, "Open", err)
	defer rawFile.Close()
	_, err = rawFile.ExecContext(ctx,
		`INSERT INTO deletion_markers (subject_token, scope, channel_id, cutoff, state, erased_at)
		 VALUES ('written-under-the-previous-key', 'messages', ?, ?, 'recorded', '2020-01-01 00:00:00')`,
		chID, retentionNow.Add(-31*24*time.Hour-12*time.Hour).Format("2006-01-02 15:04:05"))
	mustDo(t, "insert the older marker", err)

	restored := restoreOver(t, database, dbPath, backup)
	if n := replayAtStartup(t, restored, dir, markers); n != 3 {
		t.Errorf("replay removed %d message(s), want all 3 the sweep had removed", n)
	}
	if got := countMessages(t, restored, chID); got != 1 {
		t.Errorf("messages after the replay = %d, want only the fresh one", got)
	}
}
