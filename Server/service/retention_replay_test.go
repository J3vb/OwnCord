package service

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// recordingRetentionHub records each replay purge; fail makes it refuse.
type recordingRetentionHub struct {
	purged [][]int64
	fail   bool
}

func (h *recordingRetentionHub) PurgeMessagesFromReplay(_ context.Context, ids []int64) error {
	if h.fail {
		return errors.New("hub down")
	}
	h.purged = append(h.purged, append([]int64(nil), ids...))
	return nil
}

func (h *recordingRetentionHub) all() []int64 {
	var out []int64
	for _, batch := range h.purged {
		out = append(out, batch...)
	}
	slices.Sort(out)
	return out
}

// messageIDs returns the channel's message ids, ascending.
func messageIDs(t *testing.T, database *db.DB, chID int64) []int64 {
	t.Helper()
	rows, err := database.QueryContext(context.Background(), `SELECT id FROM messages WHERE channel_id = ? ORDER BY id`, chID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

// persistChatFrames writes one chat_message replay row per message, the
// shape the hub persists.
func persistChatFrames(t *testing.T, database *db.DB, chID int64, ids []int64) {
	t.Helper()
	for _, id := range ids {
		raw, _ := json.Marshal(map[string]any{"seq": id * 10, "type": "chat_message", "payload": map[string]any{"id": id, "channel_id": chID, "content": "persisted"}})
		if err := database.PersistEvent(context.Background(), id*10, "chat_message", chID, raw); err != nil {
			t.Fatal(err)
		}
	}
}

// persistedAbout counts the persisted replay rows about any of ids.
func persistedAbout(t *testing.T, database *db.DB, ids []int64) int {
	t.Helper()
	encoded, _ := json.Marshal(ids)
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM events WHERE `+db.EventNamesMessagePredicate, string(encoded)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// A sweep purges the replay tiers for what it removed — through the hub
// when one is installed, the persisted rows alone without one — and the
// run's purge journal is clear afterwards (B4-11, Codex's review of #1521).
func TestRetention_SweepPurgesTheReplayTiers(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, err := database.CreateUser(ctx, "retention-purge-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	chID, _ := seedRetentionChannel(t, database, "purge-hub", uid, dir, 3)
	ids := messageIDs(t, database, chID)
	if len(ids) != 4 {
		t.Fatalf("messages = %v, want 3 old and 1 fresh", ids)
	}
	old, fresh := ids[:3], ids[3]
	persistChatFrames(t, database, chID, ids)
	svc := newRetention(t, database, dir)
	hub := &recordingRetentionHub{}
	svc.SetHub(hub)
	if _, err := svc.SetChannelPolicy(ctx, uid, chID, 7); err != nil {
		t.Fatal(err)
	}
	rep, err := svc.Tick(ctx)
	if err != nil || rep.Messages != 3 {
		t.Fatalf("Tick = %+v, %v; want 3 messages swept", rep, err)
	}
	want := append([]int64(nil), old...)
	slices.Sort(want)
	if got := hub.all(); !slices.Equal(got, want) {
		t.Errorf("hub purged %v, want the swept %v", got, want)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("runs still listed after a successful purge: %+v", runs)
	}
	// The recording hub does not touch the rows; the real one does
	// (TestRetention_PurgeMessagesFromReplay in ws). Without a hub the
	// service removes the persisted rows itself.
	chID2, _ := seedRetentionChannel(t, database, "purge-db", uid, dir, 2)
	ids2 := messageIDs(t, database, chID2)
	old2, fresh2 := ids2[:2], ids2[2]
	persistChatFrames(t, database, chID2, ids2)
	bare := newRetention(t, database, dir)
	if _, err := bare.SetChannelPolicy(ctx, uid, chID2, 7); err != nil {
		t.Fatal(err)
	}
	if rep, err := bare.Tick(ctx); err != nil || rep.Messages != 2 {
		t.Fatalf("Tick without a hub = %+v, %v; want 2 messages swept", rep, err)
	}
	if n := persistedAbout(t, database, old2); n != 0 {
		t.Errorf("persisted rows about the swept messages = %d, want 0", n)
	}
	if n := persistedAbout(t, database, []int64{fresh2}); n != 1 {
		t.Errorf("persisted rows about the fresh message = %d, want 1", n)
	}
	_ = fresh
}

// A purge the hub refuses is journaled in the run and retried on the next
// tick; the ids are written before the purge, so a crash between the
// sweep's commit and the purge leaves them for the next tick too.
func TestRetention_ReplayPurgeIsRetriedFromTheJournal(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, err := database.CreateUser(ctx, "retention-journal-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	chID, _ := seedRetentionChannel(t, database, "purge-journal", uid, dir, 2)
	ids := messageIDs(t, database, chID)
	old := append([]int64(nil), ids[:2]...)
	slices.Sort(old)
	svc := newRetention(t, database, dir)
	hub := &recordingRetentionHub{fail: true}
	svc.SetHub(hub)
	if _, err := svc.SetChannelPolicy(ctx, uid, chID, 7); err != nil {
		t.Fatal(err)
	}
	rep, err := svc.Tick(ctx)
	if rep.Messages != 2 {
		t.Fatalf("Tick = %+v, %v; want the 2 messages swept regardless of the purge", rep, err)
	}
	if err == nil || !strings.Contains(err.Error(), "replay purge pending") {
		t.Errorf("Tick error = %v, want the pending purge reported", err)
	}
	runs, err := database.ListUnfinishedRetentionRuns(ctx)
	if err != nil || len(runs) != 1 || !slices.Equal(runs[0].PurgePending, old) {
		t.Fatalf("runs after the refused purge = %+v, %v; want one with %v pending", runs, err, old)
	}
	if runs[0].FinishedAt == nil || runs[0].FilesRemoved != len(runs[0].Files) {
		t.Errorf("run = %+v; want it finished with its files removed, only the purge outstanding", runs[0])
	}
	if len(hub.purged) != 0 {
		t.Errorf("the refusing hub recorded purges: %v", hub.purged)
	}

	// The next tick: the hub is back, nothing is left to sweep, the resume
	// purges the journaled ids and clears them.
	hub.fail = false
	rep, err = svc.Tick(ctx)
	if err != nil || rep.Messages != 0 {
		t.Fatalf("second Tick = %+v, %v", rep, err)
	}
	if got := hub.all(); !slices.Equal(got, old) {
		t.Errorf("resumed purge = %v, want %v", got, old)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("runs still listed after the resumed purge: %+v", runs)
	}

	// The crash, by hand: ids journaled, the purge never ran, the process
	// died — the next tick purges them.
	runID, err := database.StartRetentionRun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunPurge(ctx, runID, []int64{999}); err != nil {
		t.Fatal(err)
	}
	if err := database.FinishRetentionRun(ctx, runID, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	if last := hub.purged[len(hub.purged)-1]; !slices.Equal(last, []int64{999}) {
		t.Errorf("last purge = %v, want [999] from the journal", last)
	}
	if got, _ := database.GetRetentionRun(ctx, runID); len(got.PurgePending) != 0 {
		t.Errorf("journal after the resumed purge = %v", got.PurgePending)
	}
}

// Start-up marker replay is the last gate before the server can serve a
// restored database. It resumes a deletion that committed before the prior
// process died even when there are no marker rows left to replay.
func TestRetention_ReplayMarkersResumesPendingRunBeforeServing(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	runID, err := database.StartRetentionRun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunPurge(ctx, runID, []int64{991}); err != nil {
		t.Fatal(err)
	}
	if err := database.FinishRetentionRun(ctx, runID, 0, ""); err != nil {
		t.Fatal(err)
	}

	hub := &recordingRetentionHub{}
	svc := NewRetentionService(database)
	svc.SetHub(hub)
	svc.SetMarkers(newTestMarkers(t))
	if n, err := svc.ReplayMarkers(ctx); err != nil || n != 0 {
		t.Fatalf("ReplayMarkers = %d, %v; want a successful journal-only resume", n, err)
	}
	if got := hub.all(); !slices.Equal(got, []int64{991}) {
		t.Fatalf("start-up purge = %v, want [991]", got)
	}
	if run, err := database.GetRetentionRun(ctx, runID); err != nil || len(run.PurgePending) != 0 {
		t.Fatalf("run after start-up resume = %+v, %v", run, err)
	}
}

// The start-up replay of a retention marker takes the re-swept messages'
// persisted rows out too: a restored backup holds their replay events as
// well as their rows.
func TestRetention_ReplayMarkersPurgesPersistedEvents(t *testing.T) {
	database := newTestDB(t)
	ctx := context.Background()
	dir := t.TempDir()
	uid, err := database.CreateUser(ctx, "retention-replay-owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	chID, _ := seedRetentionChannel(t, database, "purge-replay", uid, dir, 2)
	ids := messageIDs(t, database, chID)
	old, fresh := ids[:2], ids[2]
	persistChatFrames(t, database, chID, ids)
	markers := newTestMarkers(t)
	svc := NewRetentionService(database)
	svc.SetFiles(newTestStorage(t, dir))
	svc.SetMarkers(markers)
	svc.SetClock(func() time.Time { return retentionNow })
	seq, err := database.SequenceValue(ctx, db.SequenceFloorChannels)
	if err != nil {
		t.Fatal(err)
	}
	if err := markers.RecordMessagesSweep(ctx, chID, retentionNow.Add(-7*24*time.Hour).Format("2006-01-02 15:04:05"), seq); err != nil {
		t.Fatal(err)
	}
	n, err := svc.ReplayMarkers(ctx)
	if err != nil || n != 2 {
		t.Fatalf("ReplayMarkers = %d, %v; want 2 messages re-swept", n, err)
	}
	if n := persistedAbout(t, database, old); n != 0 {
		t.Errorf("persisted rows about the re-swept messages = %d, want 0", n)
	}
	if n := persistedAbout(t, database, []int64{fresh}); n != 1 {
		t.Errorf("persisted rows about the fresh message = %d, want 1", n)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("runs still listed after the replay: %+v", runs)
	}
	if floors, _ := markers.SequenceFloors(ctx); floors[db.SequenceFloorChannels] != seq {
		t.Errorf("channels floor = %v, want %d", floors, seq)
	}
}
