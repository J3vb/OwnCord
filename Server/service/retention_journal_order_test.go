package service

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// journalOrderSpy wraps the real store and, once armed, snapshots
// retention_runs.files (the current run's row) the instant the call'th
// SweepRetention returns — i.e. right after that batch's DELETE has
// committed, before the service gets a chance to journal *this* batch.
// Seeing an earlier batch's names already there, and not this batch's,
// proves the journal write for a batch happens before the next batch's
// destructive step runs (OC-0403, and OC-0396's journal half on the
// replay path).
type journalOrderSpy struct {
	*db.DB
	calls      int
	snapshotAt int
	filesAt    []byte // raw retention_runs.files read right after call snapshotAt
}

func (s *journalOrderSpy) SweepRetention(ctx context.Context, channelID int64, cutoff time.Time, limit int) ([]int64, []string, error) {
	ids, files, err := s.DB.SweepRetention(ctx, channelID, cutoff, limit)
	s.calls++
	if s.calls == s.snapshotAt {
		var raw string
		if scanErr := s.DB.QueryRowContext(ctx, `SELECT files FROM retention_runs ORDER BY id DESC LIMIT 1`).Scan(&raw); scanErr == nil {
			s.filesAt = []byte(raw)
		}
	}
	return ids, files, err
}

func filesJSON(t *testing.T, raw []byte) []string {
	t.Helper()
	if raw == nil {
		return nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("retention_runs.files = %q, not valid JSON: %v", raw, err)
	}
	return out
}

// Tick journals a channel's swept file names after every batch's commit,
// not once after the whole run: a kill anywhere past a batch's commit still
// finds that batch's names durably journaled (OC-0403). RetentionBatch is
// 500, so 520 old messages force two batches; snapshotting the journal the
// instant batch 2 returns must already show batch 1's 500 names.
func TestRetention_TickJournalsEachBatchBeforeTheNext(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	dir := t.TempDir()
	uid, _ := database.CreateUser(ctx, "journal-owner", "hash", 1)
	_, _ = seedRetentionChannel(t, database, "journal-order", uid, dir, RetentionBatch+20)
	if err := database.ApplySettings(ctx, map[string]string{db.RetentionDaysKey: "7"}); err != nil {
		t.Fatal(err)
	}
	spy := &journalOrderSpy{DB: database, snapshotAt: 2}
	svc := NewRetentionService(spy)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetClock(func() time.Time { return retentionNow })

	rep, err := svc.Tick(ctx)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	// Pins the run's totals against double counting once journaling moves
	// into the per-batch loop.
	if rep.Messages != RetentionBatch+20 {
		t.Fatalf("Tick removed %d messages, want %d", rep.Messages, RetentionBatch+20)
	}
	if spy.calls < 2 {
		t.Fatalf("SweepRetention called %d times, want at least 2 batches", spy.calls)
	}
	atBatch2 := filesJSON(t, spy.filesAt)
	if len(atBatch2) != RetentionBatch {
		t.Fatalf("journal before batch 2 = %d files, want %d (batch 1's names, journaled before batch 2's delete ran)", len(atBatch2), RetentionBatch)
	}
}

// seedStaleMarkerBacklog seeds a channel with n old messages, each with an
// attachment row whose file is never written to disk — removeFiles treats a
// missing file as removed, so this stays cheap even at n in the thousands,
// which a marker replay's backlog realistically can be.
func seedStaleMarkerBacklog(t *testing.T, database *db.DB, uid int64, n int) (chID int64) {
	t.Helper()
	ctx := context.Background()
	chID, err := database.CreateChannel(ctx, "stale-backlog", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	for i := range n {
		res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content, timestamp) VALUES (?, ?, ?, ?)`,
			chID, uid, fmt.Sprintf("stale %d", i), retentionNow.Add(-time.Duration(400+i)*24*time.Hour).Format("2006-01-02 15:04:05"))
		if err != nil {
			t.Fatal(err)
		}
		mid, _ := res.LastInsertId()
		stored := fmt.Sprintf("stale-%d", i)
		if _, err := database.ExecContext(ctx, `INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploader_id) VALUES (?, ?, 'f', ?, 'image/png', 1, ?)`,
			stored, mid, stored, uid); err != nil {
			t.Fatal(err)
		}
	}
	return chID
}

// A marker's backlog spanning several batches, and more than one
// RetentionTickBudget, is still removed in full by ReplayMarkers — bounded
// per pass, not capped overall (OC-0396, brief's preferred option A): the
// documented start-up guarantee (docs/architecture/data-lifecycle.md:356-358,
// "a restored backup ... loses them again before anything serves") does not
// hold if the replay stops at a budget. The spy also pins, directly on the
// replay path rather than only through Tick, that a batch's files are
// journaled before the next batch's delete runs.
func TestRetention_ReplayMarkersSweepsPastOneBudgetAndJournalsEachBatch(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "backlog-owner", "hash", 1)
	backlog := RetentionTickBudget + RetentionBatch + 20 // forces a second pass past one budget
	chID := seedStaleMarkerBacklog(t, database, uid, backlog)
	markers := newTestMarkers(t)
	dir := t.TempDir()
	spy := &journalOrderSpy{DB: database, snapshotAt: 2} // right after batch 2's DELETE commits
	svc := NewRetentionService(spy)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	seq, err := database.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil {
		t.Fatal(err)
	}
	if err := markers.RecordMessagesSweep(ctx, chID, retentionNow.Add(-time.Hour).Format("2006-01-02 15:04:05"), seq); err != nil {
		t.Fatal(err)
	}

	n, err := svc.ReplayMarkers(ctx)
	if err != nil {
		t.Fatalf("ReplayMarkers: %v", err)
	}
	if n != backlog {
		t.Fatalf("ReplayMarkers removed %d, want the whole backlog %d (must not stop at RetentionTickBudget %d)", n, backlog, RetentionTickBudget)
	}
	if got := countMessages(t, database, chID); got != 0 {
		t.Errorf("messages left after the replay = %d, want 0", got)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("runs still listed after the replay: %+v", runs)
	}
	atBatch2 := filesJSON(t, spy.filesAt)
	if len(atBatch2) != RetentionBatch {
		t.Fatalf("journal before batch 2 of the replay = %d files, want %d (batch 1's names, journaled before batch 2's delete ran)", len(atBatch2), RetentionBatch)
	}
}
