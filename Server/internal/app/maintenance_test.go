package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// newMaintenanceTestDB opens an in-memory database with the full migration
// set applied, the shape every direct maintenance test needs.
func newMaintenanceTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// dbVoiceMuterForTest routes service.TimeoutVoiceMuter through the real
// db.MuteForTimeoutSession/ClearServerMuteOwnedBy — no ws.Hub, per-user
// lock, or LiveKit involved — enough for the reconcile sweep's own tests,
// which only need the DB half of the contract.
type dbVoiceMuterForTest struct{ database *db.DB }

func (m *dbVoiceMuterForTest) MuteForTimeout(ctx context.Context, userID, channelID, actionID int64, joinedAt string, supersededIDs []int64) (bool, bool) {
	matched, transitioned, err := m.database.MuteForTimeoutSession(ctx, userID, channelID, actionID, joinedAt, supersededIDs)
	if err != nil || !matched {
		return false, false
	}
	return true, transitioned
}

func (m *dbVoiceMuterForTest) UnmuteForTimeout(ctx context.Context, userID int64, actionIDs []int64) bool {
	_, _, cleared, err := m.database.ClearServerMuteOwnedBy(ctx, userID, actionIDs)
	return err == nil && cleared
}

// newReconcileTestFixture seeds an owner, a member in a real voice channel,
// and a ModerationService wired to dbVoiceMuterForTest — the round-4
// (B5-10 addendum) reconcile sweep's tests all start from this.
func newReconcileTestFixture(t *testing.T) (database *db.DB, m *maintenance, ownerID, memberID, chanID int64) {
	t.Helper()
	database = newMaintenanceTestDB(t)
	ctx := context.Background()
	var err error
	ownerID, err = database.CreateUser(ctx, "recon-owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser(owner): %v", err)
	}
	memberID, err = database.CreateUser(ctx, "recon-member", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser(member): %v", err)
	}
	chanID, err = database.CreateChannel(ctx, "recon-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.JoinVoiceChannel(ctx, memberID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	mod := service.NewModerationService(database, nil)
	mod.SetVoiceMuter(&dbVoiceMuterForTest{database: database})
	m = &maintenance{log: slog.Default(), database: database, moderation: mod}
	return database, m, ownerID, memberID, chanID
}

// TestReconcileOrphanedVoiceMutes_ExpiredTimeoutUnmuted is the gap the
// addendum names directly: a timeout that simply EXPIRES, with nobody ever
// calling LiftTimeout, had no unmute mechanism at all before this sweep.
func TestReconcileOrphanedVoiceMutes_ExpiredTimeoutUnmuted(t *testing.T) {
	database, m, ownerID, memberID, chanID := newReconcileTestFixture(t)
	ctx := context.Background()
	state, err := database.GetVoiceState(ctx, memberID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	// Issued (and muted) while still active, exactly like a real timeout —
	// round 5's Codex review P2 refuses a mute attempt whose OWN action is
	// already inactive, so the setup must mute FIRST and expire it
	// afterward, simulating a timeout whose expiry has since passed with
	// nobody having lifted it.
	actionID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, memberID, chanID, actionID, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE moderation_actions SET expires_at = ? WHERE id = ?`,
		time.Now().Add(-time.Hour).UTC().Format("2006-01-02 15:04:05"), actionID); err != nil {
		t.Fatalf("backdate expires_at: %v", err)
	}

	if err := m.reconcileOrphanedVoiceMutes(ctx); err != nil {
		t.Fatalf("reconcileOrphanedVoiceMutes: %v", err)
	}
	final, err := database.GetVoiceState(ctx, memberID)
	if err != nil || final == nil {
		t.Fatalf("GetVoiceState (final): %v", err)
	}
	if final.ServerMuted {
		t.Error("ServerMuted = true, want false: the expired timeout's mute must have been reconciled")
	}
}

// TestReconcileOrphanedVoiceMutes_LeavesManualMuteAlone: a moderator's
// manual mute (voice_mod_mute, server_muted_by always NULL) is never a
// candidate — it owns nothing this sweep is entitled to touch.
func TestReconcileOrphanedVoiceMutes_LeavesManualMuteAlone(t *testing.T) {
	database, m, _, memberID, chanID := newReconcileTestFixture(t)
	ctx := context.Background()
	if matched, err := database.SetVoiceServerMute(ctx, memberID, chanID, true); err != nil || !matched {
		t.Fatalf("SetVoiceServerMute: matched=%v err=%v", matched, err)
	}

	if err := m.reconcileOrphanedVoiceMutes(ctx); err != nil {
		t.Fatalf("reconcileOrphanedVoiceMutes: %v", err)
	}
	state, err := database.GetVoiceState(ctx, memberID)
	if err != nil || state == nil || !state.ServerMuted {
		t.Fatal("the manual mute must still be in effect after the sweep")
	}
}

// TestReconcileOrphanedVoiceMutes_CrashBetweenLiftAndFinalize: the ledger
// half of a lift commits (db.LiftTimeout), but the process crashes before
// ModerationService.FinalizeTimeoutLift ever runs — the voice_states row is
// left pointing at an already-lifted action. The next sweep must still end
// unmuted, not leave it stranded until someone happens to lift again.
func TestReconcileOrphanedVoiceMutes_CrashBetweenLiftAndFinalize(t *testing.T) {
	database, m, ownerID, memberID, chanID := newReconcileTestFixture(t)
	ctx := context.Background()
	state, err := database.GetVoiceState(ctx, memberID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	actionID, _, err := database.TimeoutUser(ctx, memberID, ownerID, nil, "cool off", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	if matched, transitioned, err := database.MuteForTimeoutSession(ctx, memberID, chanID, actionID, state.JoinedAt, nil); err != nil || !matched || !transitioned {
		t.Fatalf("MuteForTimeoutSession: matched=%v transitioned=%v err=%v", matched, transitioned, err)
	}

	// The ledger half of the lift commits — and the crash happens right
	// here, before FinalizeTimeoutLift (the post-commit half) ever runs.
	if _, err := database.LiftTimeout(ctx, memberID, ownerID); err != nil {
		t.Fatalf("LiftTimeout: %v", err)
	}
	stillMuted, err := database.GetVoiceState(ctx, memberID)
	if err != nil || stillMuted == nil || !stillMuted.ServerMuted {
		t.Fatal("test setup broken: the voice half must still show muted immediately after the ledger-only lift")
	}

	if err := m.reconcileOrphanedVoiceMutes(ctx); err != nil {
		t.Fatalf("reconcileOrphanedVoiceMutes: %v", err)
	}
	final, err := database.GetVoiceState(ctx, memberID)
	if err != nil || final == nil {
		t.Fatalf("GetVoiceState (final): %v", err)
	}
	if final.ServerMuted {
		t.Error("ServerMuted = true, want false: the sweep must repair a crash between the ledger commit and its finalize")
	}
}

// TestMaintenance_StepOrderIsPinned is the seam contract: the pass runs these
// sweeps in this order, and the reconciliation passes come after the sweeps
// that strand what they reconcile. A step added out of place — a new sweep
// after the storage reconciliation, say — fails here by name, which is the
// point: B5-4 and B5-11 add a row to steps() and to this list together.
func TestMaintenance_StepOrderIsPinned(t *testing.T) {
	m := newMaintenance(slog.Default(), &config.Config{Upload: config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1}}, newMaintenanceTestDB(t), nil)
	got := make([]string, 0, len(m.steps()))
	for _, step := range m.steps() {
		got = append(got, step.name)
	}
	want := []string{
		"failed to delete expired sessions",
		"failed to clean up expired second-factor state",
		"backup maintenance failed",
		"failed to delete orphaned attachments",
		"retention sweep failed",
		"report content retention failed",
		"moderation action retention failed",
		"orphaned voice mute reconciliation failed",
		"erasure jobs still pending",
		"storage reconciliation failed",
		"storage recount failed",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("maintenance steps =\n  %q\nwant\n  %q", got, want)
	}
}

// TestMaintenance_TickWithNoServicesSucceeds pins that a partial wiring (no
// services at all) is a no-op pass, not a failed one: every service-backed
// step skips itself, so the circuit breaker never trips on a wiring gap.
func TestMaintenance_TickWithNoServicesSucceeds(t *testing.T) {
	m := newMaintenance(slog.Default(), &config.Config{Upload: config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1}}, newMaintenanceTestDB(t), nil)
	if failed := m.tick(context.Background()); failed {
		t.Fatal("tick reported failure with every service-backed step skipped")
	}
}

// TestMaintenance_TickReturnsBytesTheOrphanSweepFreed is the sweep-level
// reconciliation proof (B5-2, decision 11): an attachment charged to its
// uploader, orphaned and past the grace period, is deleted by the orphan
// sweep and its bytes returned by the recount in the SAME tick — the recount
// runs last on purpose. A restart between the two (a fresh maintenance over
// the same database) repairs it just the same, from the loop's start-up
// recount.
func TestMaintenance_TickReturnsBytesTheOrphanSweepFreed(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	// Migration 001 schedules a daily backup, and a full tick would write one
	// under a path relative to this package. Off: this test is about the
	// storage steps.
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cfg := &config.Config{Upload: config.UploadConfig{StorageDir: dir, MaxSizeMB: 1}}
	svc := service.New(database, auth.NewRateLimiter())
	svc.Uploads.SetStorageLimits(service.StorageLimits{Dir: dir})

	// An upload as the handler does it: reserve, write, record.
	res, err := svc.Uploads.Reserve(ctx, 10, 6)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "orphan-1"), []byte("6bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.Uploads.Record(ctx, service.AttachmentRecord{ID: "orphan-1", UploaderID: 10, Filename: "o.bin", MimeType: "application/octet-stream", Size: 6}, res); err != nil {
		t.Fatal(err)
	}
	// Never attached, and older than the sweep's one-hour grace.
	old := time.Now().Add(-2 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := database.ExecContext(ctx, `UPDATE attachments SET uploaded_at = ? WHERE id = 'orphan-1'`, old); err != nil {
		t.Fatal(err)
	}
	if used, _ := svc.Uploads.StorageUsed(ctx, 10); used != 6 {
		t.Fatalf("counter before the tick = %d, want 6", used)
	}

	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}
	if _, err := os.Stat(filepath.Join(dir, "orphan-1")); !os.IsNotExist(err) {
		t.Fatalf("orphan file still on disk after the sweep: %v", err)
	}
	if used, _ := svc.Uploads.StorageUsed(ctx, 10); used != 0 {
		t.Fatalf("counter after the tick = %d, want 0: the recount must run after the orphan sweep", used)
	}

	// Restart shape: a charge with no row, a fresh process, the loop's
	// start-up recount.
	if _, err := svc.Uploads.Reserve(ctx, 10, 9); err != nil {
		t.Fatal(err)
	}
	fresh := service.New(database, auth.NewRateLimiter())
	if used, _ := fresh.Uploads.StorageUsed(ctx, 10); used != 9 {
		t.Fatalf("phantom charge before the restart recount = %d, want 9 (kept, high side)", used)
	}
	if err := newMaintenance(slog.Default(), cfg, database, fresh).recountStorage(ctx); err != nil {
		t.Fatal(err)
	}
	if used, _ := fresh.Uploads.StorageUsed(ctx, 10); used != 0 {
		t.Fatalf("phantom charge after the restart recount = %d, want 0", used)
	}
}

// seedAgedClosedReport inserts a closed report, one evidence row and one
// note, all with real content, closed daysAgo days ago. Returns the id.
func seedAgedClosedReport(t *testing.T, database *db.DB, ctx context.Context, id int64, daysAgo int) int64 {
	t.Helper()
	closedAt := time.Now().Add(-time.Duration(daysAgo) * 24 * time.Hour).UTC().Format("2006-01-02 15:04:05")
	if _, err := database.ExecContext(ctx,
		`INSERT INTO reports (id, public_id, reporter_id, subject_id, target_type, target_ref, reason, detail, state, outcome, created_at, updated_at, closed_at)
		 VALUES (?, ?, 10, 11, 'message', '1', 'spam', 'the reporter''s written detail', 'resolved', 'actioned', ?, ?, ?)`,
		id, fmt.Sprintf("pub-aged-%d", id), closedAt, closedAt, closedAt); err != nil {
		t.Fatalf("seed report %d: %v", id, err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_evidence (report_id, seq, author_id, content) VALUES (?, 0, 11, 'the reported message content')`, id); err != nil {
		t.Fatalf("seed evidence for report %d: %v", id, err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO report_notes (report_id, author_id, body) VALUES (?, 2, 'a moderator note')`, id); err != nil {
		t.Fatalf("seed note for report %d: %v", id, err)
	}
	return id
}

// TestMaintenance_ReportRetentionZeroDaysNeverPrunes is P2-11's zero-config
// regression test: a tick run with moderation.report_retention_days = 0 must
// leave a long-closed report's content untouched, because pruneReportContent
// checks the config value before ever calling PruneClosedContent.
func TestMaintenance_ReportRetentionZeroDaysNeverPrunes(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4), (11, 'bob', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	id := seedAgedClosedReport(t, database, ctx, 9001, 400)

	cfg := &config.Config{
		Upload:     config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1},
		Moderation: config.ModerationConfig{ReportRetentionDays: 0},
	}
	svc := service.New(database, auth.NewRateLimiter())
	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}

	var detail string
	if err := database.QueryRowContext(ctx, `SELECT detail FROM reports WHERE id = ?`, id).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if detail == "" {
		t.Error("detail was cleared with report_retention_days = 0, want untouched")
	}
	var evidenceRows, noteRows int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_evidence WHERE report_id = ?`, id).Scan(&evidenceRows); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_notes WHERE report_id = ?`, id).Scan(&noteRows); err != nil {
		t.Fatal(err)
	}
	if evidenceRows != 1 || noteRows != 1 {
		t.Errorf("evidence/notes = %d/%d after a report_retention_days=0 tick, want 1/1 (untouched)", evidenceRows, noteRows)
	}
}

// TestMaintenance_ReportRetentionPrunesOnlyAgedContent is P2-11's
// threshold regression test, driven through the real maintenance tick (as
// B5-4's orphan-sweep test drives m.tick rather than calling the service
// method directly): with report_retention_days = 180, a report closed 200
// days ago loses its content but keeps its row and outcome, while a report
// closed only 10 days ago is left completely alone.
func TestMaintenance_ReportRetentionPrunesOnlyAgedContent(t *testing.T) {
	database := newMaintenanceTestDB(t)
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `INSERT INTO users (id, username, password, role_id) VALUES (10, 'alice', 'x', 4), (11, 'bob', 'x', 4)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE settings SET value = 'off' WHERE key = 'backup_schedule'`); err != nil {
		t.Fatal(err)
	}
	oldID := seedAgedClosedReport(t, database, ctx, 9002, 200)
	recentID := seedAgedClosedReport(t, database, ctx, 9003, 10)

	cfg := &config.Config{
		Upload:     config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1},
		Moderation: config.ModerationConfig{ReportRetentionDays: 180},
	}
	svc := service.New(database, auth.NewRateLimiter())
	m := newMaintenance(slog.Default(), cfg, database, svc)
	if failed := m.tick(ctx); failed {
		t.Fatal("tick reported a failed step")
	}

	assertReportContent := func(id int64, wantDetail string, wantEvidence, wantNotes int) {
		t.Helper()
		var detail, state, outcome string
		if err := database.QueryRowContext(ctx, `SELECT detail, state, outcome FROM reports WHERE id = ?`, id).Scan(&detail, &state, &outcome); err != nil {
			t.Fatalf("report %d: %v", id, err)
		}
		if detail != wantDetail {
			t.Errorf("report %d detail = %q, want %q", id, detail, wantDetail)
		}
		if state != "resolved" || outcome != "actioned" {
			t.Errorf("report %d state/outcome = %q/%q, want resolved/actioned (kept)", id, state, outcome)
		}
		var evidenceRows, noteRows int
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_evidence WHERE report_id = ?`, id).Scan(&evidenceRows); err != nil {
			t.Fatal(err)
		}
		if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM report_notes WHERE report_id = ?`, id).Scan(&noteRows); err != nil {
			t.Fatal(err)
		}
		if evidenceRows != wantEvidence || noteRows != wantNotes {
			t.Errorf("report %d evidence/notes = %d/%d, want %d/%d", id, evidenceRows, noteRows, wantEvidence, wantNotes)
		}
	}
	assertReportContent(oldID, "", 0, 0)
	assertReportContent(recentID, "the reporter's written detail", 1, 1)
}
