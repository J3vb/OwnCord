package db_test

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// persistFrame writes one wrapped broadcast envelope to the events table,
// the shape the hub persists.
func persistFrame(t *testing.T, database *db.DB, seq, channelID int64, frameType string, payload map[string]any) {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"seq": seq, "type": frameType, "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.PersistEvent(context.Background(), seq, frameType, channelID, raw); err != nil {
		t.Fatalf("PersistEvent: %v", err)
	}
}

func countEvents(t *testing.T, database *db.DB, where string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM events WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// DeleteEventsForMessages removes every message-family frame about the
// given ids — the content-bearing chat_message and chat_edited, the
// deletion notices, reaction updates — and nothing else: a frame of another
// type whose payload.id happens to collide stays, as do frames about other
// messages (B4-11, Codex's review of #1521).
func TestDeleteEventsForMessages_MatchesTheMessageFamily(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	persistFrame(t, database, 1, 7, "chat_message", map[string]any{"id": 100, "channel_id": 7, "content": "old"})
	persistFrame(t, database, 2, 7, "chat_edited", map[string]any{"message_id": 100, "channel_id": 7, "content": "old, edited"})
	persistFrame(t, database, 3, 7, "reaction_update", map[string]any{"message_id": 101, "channel_id": 7, "emoji": "x", "user_id": 1, "action": "add"})
	persistFrame(t, database, 4, 7, "chat_deleted", map[string]any{"message_id": 102, "channel_id": 7})
	persistFrame(t, database, 5, 7, "chat_bulk_deleted", map[string]any{"channel_id": 7, "ids": []int64{5, 101, 9}})
	persistFrame(t, database, 6, 7, "chat_message", map[string]any{"id": 200, "channel_id": 7, "content": "kept"})
	persistFrame(t, database, 7, 0, "channel_update", map[string]any{"id": 100, "name": "a channel whose id collides"})
	persistFrame(t, database, 8, 7, "chat_bulk_deleted", map[string]any{"channel_id": 7, "ids": []int64{200}})

	if n, err := database.DeleteEventsForMessages(ctx, nil); err != nil || n != 0 {
		t.Fatalf("empty purge = %d, %v", n, err)
	}
	if n := countEvents(t, database, "1 = 1"); n != 8 {
		t.Fatalf("an empty purge touched rows: %d left of 8", n)
	}
	n, err := database.DeleteEventsForMessages(ctx, []int64{100, 101, 102})
	if err != nil {
		t.Fatal(err)
	}
	if n != 5 {
		t.Errorf("rows deleted = %d, want 5", n)
	}
	for _, seq := range []int64{1, 2, 3, 4, 5} {
		if countEvents(t, database, "seq = ?", seq) != 0 {
			t.Errorf("seq %d (about a purged message) survived", seq)
		}
	}
	for _, seq := range []int64{6, 7, 8} {
		if countEvents(t, database, "seq = ?", seq) != 1 {
			t.Errorf("seq %d (not about a purged message) was removed", seq)
		}
	}
}

// The run journal keeps the ids whose replay purge is outstanding: written
// before the purge, cleared after it; a run with ids pending stays listed
// for the resume even once finished with its files gone.
func TestRetentionRuns_PurgeJournal(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	runID, err := database.StartRetentionRun(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunFiles(ctx, runID, 1, 3, nil); err != nil {
		t.Fatal(err)
	}
	if err := database.RecordRetentionRunPurge(ctx, runID, []int64{10, 11, 12}); err != nil {
		t.Fatal(err)
	}
	if err := database.FinishRetentionRun(ctx, runID, 0, ""); err != nil {
		t.Fatal(err)
	}
	runs, err := database.ListUnfinishedRetentionRuns(ctx)
	if err != nil || len(runs) != 1 || !slices.Equal(runs[0].PurgePending, []int64{10, 11, 12}) {
		t.Fatalf("unfinished runs = %+v, %v; want the finished run listed for its pending purge", runs, err)
	}
	got, err := database.GetRetentionRun(ctx, runID)
	if err != nil || !slices.Equal(got.PurgePending, []int64{10, 11, 12}) {
		t.Fatalf("GetRetentionRun = %+v, %v", got, err)
	}
	if err := database.RecordRetentionRunPurge(ctx, runID, nil); err != nil {
		t.Fatal(err)
	}
	if runs, _ := database.ListUnfinishedRetentionRuns(ctx); len(runs) != 0 {
		t.Errorf("a run with nothing pending is still listed: %+v", runs)
	}
	if got, _ := database.GetRetentionRun(ctx, runID); len(got.PurgePending) != 0 {
		t.Errorf("purge_pending after clearing = %v", got.PurgePending)
	}
}
