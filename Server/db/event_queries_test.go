package db_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The events table backs cold-tier reconnect replay: when a client's last_seq
// falls out of the in-memory ring, the hub refills from here. GetMaxEventSeq
// (which seeds the hub's counter at startup) and PruneEventsOlderThan (the
// retention job) had no coverage, and neither did the channel filter that
// keeps a replay from leaking events for channels the client cannot see.

func TestPersistEvent_AndGetEventsSince(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	for seq := int64(1); seq <= 3; seq++ {
		if err := database.PersistEvent(ctx, seq, "chat_message", 10, []byte(`{"n":1}`)); err != nil {
			t.Fatalf("PersistEvent(%d): %v", seq, err)
		}
	}

	all, err := database.GetEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatalf("GetEventsSince: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("GetEventsSince(0) returned %d events, want 3", len(all))
	}
	for i, e := range all {
		if e.Seq != int64(i+1) {
			t.Errorf("event[%d].Seq = %d, want %d — replay depends on ascending order", i, e.Seq, i+1)
		}
		if e.EventType != "chat_message" {
			t.Errorf("event[%d].EventType = %q", i, e.EventType)
		}
		if e.CreatedAt.IsZero() {
			t.Errorf("event[%d].CreatedAt is zero; parseSQLiteTime failed to parse the row", i)
		}
	}

	// afterSeq is exclusive.
	tail, err := database.GetEventsSince(ctx, 2, 100)
	if err != nil {
		t.Fatalf("GetEventsSince(2): %v", err)
	}
	if len(tail) != 1 || tail[0].Seq != 3 {
		t.Errorf("GetEventsSince(2) = %+v, want only seq 3", tail)
	}
}

func TestPersistEvents_BatchInsertsAll(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	batch := []db.PersistedEvent{
		{Seq: 1, EventType: "chat_message", ChannelID: 10, Payload: []byte(`{"n":1}`)},
		{Seq: 2, EventType: "chat_message", ChannelID: 10, Payload: []byte(`{"n":2}`)},
		{Seq: 3, EventType: "presence", ChannelID: 0, Payload: []byte(`{"n":3}`)},
	}
	persisted, err := database.PersistEvents(ctx, batch)
	if err != nil {
		t.Fatalf("PersistEvents: %v", err)
	}
	if persisted != 3 {
		t.Fatalf("persisted = %d, want 3", persisted)
	}

	rows, err := database.GetEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatalf("GetEventsSince: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("stored %d events, want 3", len(rows))
	}
	for i, e := range rows {
		if e.Seq != batch[i].Seq || e.EventType != batch[i].EventType || e.ChannelID != batch[i].ChannelID {
			t.Errorf("row[%d] = %+v, want seq/type/channel of %+v", i, e, batch[i])
		}
	}
}

func TestPersistEvents_EmptyBatchIsNoop(t *testing.T) {
	database := newMigratedTestDB(t)

	persisted, err := database.PersistEvents(context.Background(), nil)
	if err != nil {
		t.Fatalf("PersistEvents(nil): %v", err)
	}
	if persisted != 0 {
		t.Errorf("persisted = %d, want 0", persisted)
	}
}

// One bad row must not drop the batch: the tx fails (duplicate seq is the
// PRIMARY KEY), and the per-row fallback still lands the good rows —
// best-effort semantics identical to the old per-event loop.
func TestPersistEvents_FallbackKeepsGoodRowsOnBadBatch(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	if err := database.PersistEvent(ctx, 2, "e", 0, []byte(`{}`)); err != nil {
		t.Fatalf("PersistEvent: %v", err)
	}

	persisted, err := database.PersistEvents(ctx, []db.PersistedEvent{
		{Seq: 1, EventType: "e", ChannelID: 0, Payload: []byte(`{}`)},
		{Seq: 2, EventType: "e", ChannelID: 0, Payload: []byte(`{}`)}, // duplicate — fails
		{Seq: 3, EventType: "e", ChannelID: 0, Payload: []byte(`{}`)},
	})
	if persisted != 2 {
		t.Errorf("persisted = %d, want 2 (rows 1 and 3 via fallback)", persisted)
	}
	if err == nil {
		t.Error("PersistEvents must report the lost row's error")
	}

	rows, qErr := database.GetEventsSince(ctx, 0, 100)
	if qErr != nil {
		t.Fatalf("GetEventsSince: %v", qErr)
	}
	if len(rows) != 3 {
		t.Fatalf("stored %d events, want 3 (pre-existing 2 plus fallback 1 and 3)", len(rows))
	}
	for i, want := range []int64{1, 2, 3} {
		if rows[i].Seq != want {
			t.Errorf("row[%d].Seq = %d, want %d", i, rows[i].Seq, want)
		}
	}
}

func TestGetEventsSince_RespectsLimit(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	for seq := int64(1); seq <= 10; seq++ {
		if err := database.PersistEvent(ctx, seq, "e", 0, []byte(`{}`)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
	}

	got, err := database.GetEventsSince(ctx, 0, 4)
	if err != nil {
		t.Fatalf("GetEventsSince: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("returned %d events, want the 4-row limit", len(got))
	}
	if got[0].Seq != 1 || got[3].Seq != 4 {
		t.Errorf("limited window = seq %d..%d, want 1..4", got[0].Seq, got[3].Seq)
	}
}

func TestGetEventsSinceForChannels(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	// seq 1: global; 2: channel 10; 3: channel 20; 4: channel 30.
	events := []struct {
		seq       int64
		channelID int64
	}{{1, 0}, {2, 10}, {3, 20}, {4, 30}}
	for _, e := range events {
		if err := database.PersistEvent(ctx, e.seq, "e", e.channelID, []byte(`{}`)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
	}

	t.Run("no channels returns globals only", func(t *testing.T) {
		got, err := database.GetEventsSinceForChannels(ctx, 0, nil, 100)
		if err != nil {
			t.Fatalf("GetEventsSinceForChannels: %v", err)
		}
		if len(got) != 1 || got[0].Seq != 1 {
			t.Errorf("got %+v, want only the global event", got)
		}
	})

	t.Run("visible channels plus globals", func(t *testing.T) {
		got, err := database.GetEventsSinceForChannels(ctx, 0, []int64{10, 20}, 100)
		if err != nil {
			t.Fatalf("GetEventsSinceForChannels: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("got %d events, want 3 (global + channels 10 and 20): %+v", len(got), got)
		}
		// Channel 30 is not visible to this client and must never appear.
		for _, e := range got {
			if e.ChannelID == 30 {
				t.Errorf("replay leaked an event for channel 30: %+v", e)
			}
		}
	})

	t.Run("afterSeq is applied with the channel filter", func(t *testing.T) {
		got, err := database.GetEventsSinceForChannels(ctx, 2, []int64{10, 20}, 100)
		if err != nil {
			t.Fatalf("GetEventsSinceForChannels: %v", err)
		}
		if len(got) != 1 || got[0].Seq != 3 {
			t.Errorf("got %+v, want only seq 3", got)
		}
	})

	t.Run("limit is applied", func(t *testing.T) {
		got, err := database.GetEventsSinceForChannels(ctx, 0, []int64{10, 20}, 2)
		if err != nil {
			t.Fatalf("GetEventsSinceForChannels: %v", err)
		}
		if len(got) != 2 {
			t.Errorf("got %d events, want the 2-row limit", len(got))
		}
	})
}

func TestGetMaxEventSeq(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	// On an empty table MAX(seq) is NULL — the hub seeds its counter from this
	// at startup, so it has to come back as 0 rather than an error.
	got, err := database.GetMaxEventSeq(ctx)
	if err != nil {
		t.Fatalf("GetMaxEventSeq on empty: %v", err)
	}
	if got != 0 {
		t.Errorf("GetMaxEventSeq on an empty table = %d, want 0", got)
	}

	for _, seq := range []int64{1, 7, 4} {
		if err := database.PersistEvent(ctx, seq, "e", 0, []byte(`{}`)); err != nil {
			t.Fatalf("PersistEvent(%d): %v", seq, err)
		}
	}

	got, err = database.GetMaxEventSeq(ctx)
	if err != nil {
		t.Fatalf("GetMaxEventSeq: %v", err)
	}
	if got != 7 {
		t.Errorf("GetMaxEventSeq = %d, want 7 (the highest, not the last inserted)", got)
	}
}

func TestPruneEventsOlderThan(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	// created_at defaults to CURRENT_TIMESTAMP, so backdate the old rows
	// explicitly in the same "2006-01-02 15:04:05" format the prune compares.
	old := time.Now().UTC().Add(-48 * time.Hour).Format("2006-01-02 15:04:05")
	for _, seq := range []int64{1, 2} {
		if err := database.PersistEvent(ctx, seq, "e", 0, []byte(`{}`)); err != nil {
			t.Fatalf("PersistEvent: %v", err)
		}
		if _, err := database.ExecContext(ctx,
			`UPDATE events SET created_at = ? WHERE seq = ?`, old, seq); err != nil {
			t.Fatalf("backdate seq %d: %v", seq, err)
		}
	}
	if err := database.PersistEvent(ctx, 3, "e", 0, []byte(`{}`)); err != nil {
		t.Fatalf("PersistEvent: %v", err)
	}

	deleted, err := database.PruneEventsOlderThan(ctx, time.Now().UTC().Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("PruneEventsOlderThan: %v", err)
	}
	if deleted != 2 {
		t.Errorf("deleted = %d, want 2", deleted)
	}

	remaining, err := database.GetEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatalf("GetEventsSince: %v", err)
	}
	if len(remaining) != 1 || remaining[0].Seq != 3 {
		t.Errorf("remaining = %+v, want only the recent event", remaining)
	}
}

func TestPruneEventsOlderThan_NothingToPrune(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	if err := database.PersistEvent(ctx, 1, "e", 0, []byte(`{}`)); err != nil {
		t.Fatalf("PersistEvent: %v", err)
	}

	deleted, err := database.PruneEventsOlderThan(ctx, time.Now().UTC().Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("PruneEventsOlderThan: %v", err)
	}
	if deleted != 0 {
		t.Errorf("deleted = %d, want 0 — a fresh event must survive the retention window", deleted)
	}
}

func TestPersistEvent_DuplicateSeqRejected(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	if err := database.PersistEvent(ctx, 1, "e", 0, []byte(`{}`)); err != nil {
		t.Fatalf("PersistEvent: %v", err)
	}
	// seq is the PRIMARY KEY; a duplicate would corrupt replay ordering, so it
	// must surface as an error rather than silently overwrite.
	if err := database.PersistEvent(ctx, 1, "e", 0, []byte(`{}`)); err == nil {
		t.Error("PersistEvent accepted a duplicate seq")
	}
}
