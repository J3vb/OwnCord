package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// framesAbout counts the ring-buffer frames about any of ids.
func framesAbout(hub *ws.Hub, ids map[int64]struct{}) int {
	n := 0
	for _, f := range hub.ReplayBuffer().AllFramesForTest() {
		if ws.EventNamesMessageForTest(f, ids) {
			n++
		}
	}
	return n
}

// countEventsAbout counts the persisted replay rows about any of ids.
func countEventsAbout(t *testing.T, database *db.DB, ids []int64) int {
	t.Helper()
	encoded, _ := json.Marshal(ids)
	var n int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM events WHERE `+db.EventNamesMessagePredicate, string(encoded)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func setOf(ids ...int64) map[int64]struct{} {
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}

// The retention sweep's replay purge (B4-11, Codex's review of #1521): the
// swept messages' frames leave the ring buffer and the events table, frames
// about other messages stay, a resume across the holes is not served from
// the ring, and a frame about a swept message that a producer hands the hub
// after the purge is dropped instead of sequenced, buffered or persisted.
func TestRetention_PurgeMessagesFromReplay(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubWith(t, ws.HubOptions{DB: database, Limiter: limiter, Services: svc})
	persister := ws.NewEventPersister(database, 256, 64, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	persister.Start(ctx)
	t.Cleanup(func() { persister.Stop(context.Background()) })
	hub.SetEventPersister(persister)
	hub.SetEventStore(database)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })

	author := seedCoverageOwner(t, database, "retention-author")
	chID := seedTestChannel(t, database, "retention-chan")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, author, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Two control frames first, so the resume point below is a seq the ring
	// holds behind an older one (the ring serves nothing from its oldest
	// slot, and 0 is "no resume").
	control, _ := json.Marshal(map[string]any{"type": "typing", "payload": map[string]any{"channel_id": chID, "user_id": author.ID}})
	hub.BroadcastToChannel(chID, control)
	hub.BroadcastToChannel(chID, control)
	waitFor(t, waitTimeout, func() bool { return hub.CurrentSeqForTest() >= 2 }, "the control frames to be sequenced")
	before := hub.CurrentSeqForTest()
	for _, content := range []string{"sweep me", "sweep me too", "keep me"} {
		raw, _ := json.Marshal(map[string]any{"type": "chat_send", "payload": map[string]any{"channel_id": chID, "content": content}})
		hub.HandleMessageForTest(c, raw)
	}
	rows, err := database.QueryContext(ctx, `SELECT id, content FROM messages WHERE channel_id = ? ORDER BY id`, chID)
	if err != nil {
		t.Fatal(err)
	}
	var swept []int64
	var kept int64
	for rows.Next() {
		var id int64
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			t.Fatal(err)
		}
		if content == "keep me" {
			kept = id
		} else {
			swept = append(swept, id)
		}
	}
	rows.Close()
	if len(swept) != 2 || kept == 0 {
		t.Fatalf("messages = swept %v, kept %d", swept, kept)
	}
	sweptSet, keptSet := setOf(swept...), setOf(kept)
	waitFor(t, waitTimeout, func() bool { return framesAbout(hub, sweptSet) == 2 && framesAbout(hub, keptSet) == 1 }, "the chat frames to reach the ring buffer")
	if err := persister.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countEventsAbout(t, database, swept); n != 2 {
		t.Fatalf("persisted rows about the messages to sweep = %d, want 2", n)
	}
	if got := hub.ReplayBuffer().EventsSince(before); len(got) < 3 {
		t.Fatalf("replay before the purge = %d frames, want the three chat frames at least", len(got))
	}

	if err := hub.PurgeMessagesFromReplay(ctx, swept); err != nil {
		t.Fatalf("PurgeMessagesFromReplay: %v", err)
	}
	if n := framesAbout(hub, sweptSet); n != 0 {
		t.Errorf("ring holds %d frames about the swept messages after the purge", n)
	}
	if n := framesAbout(hub, keptSet); n != 1 {
		t.Errorf("ring holds %d frames about the kept message, want 1 (the purge must not touch it)", n)
	}
	if n := countEventsAbout(t, database, swept); n != 0 {
		t.Errorf("events table holds %d rows about the swept messages after the purge", n)
	}
	if n := countEventsAbout(t, database, []int64{kept}); n != 1 {
		t.Errorf("events table holds %d rows about the kept message, want 1", n)
	}
	if got := hub.ReplayBuffer().EventsSince(before); got != nil {
		t.Errorf("replay across the cleared slots = %d frames, want nil (the cold tier or the full ready takes over)", len(got))
	}

	// The late producer: an edit of a swept message reaches the hub after
	// the purge. A harmless frame behind it is sequenced; the edit is not,
	// nor buffered, nor persisted.
	seqBefore := hub.CurrentSeqForTest()
	late, _ := json.Marshal(map[string]any{"type": "chat_edited", "payload": map[string]any{"message_id": swept[0], "channel_id": chID, "content": "late edit", "edited_at": "now"}})
	hub.BroadcastToChannel(chID, late)
	harmless, _ := json.Marshal(map[string]any{"type": "typing", "payload": map[string]any{"channel_id": chID, "user_id": author.ID}})
	hub.BroadcastToChannel(chID, harmless)
	waitFor(t, waitTimeout, func() bool { return hub.CurrentSeqForTest() > seqBefore }, "the harmless frame to be sequenced")
	if hub.CurrentSeqForTest() != seqBefore+1 {
		t.Errorf("seq advanced by %d, want 1 (the late frame about a swept message must not take a seq)", hub.CurrentSeqForTest()-seqBefore)
	}
	if n := framesAbout(hub, sweptSet); n != 0 {
		t.Errorf("ring holds %d frames about the swept messages after the late broadcast", n)
	}
	if err := persister.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countEventsAbout(t, database, swept); n != 0 {
		t.Errorf("events table holds %d rows about the swept messages after the late broadcast", n)
	}
	// A frame about the kept message is still sequenced: the tombstone set
	// holds the swept ids only.
	seqBefore = hub.CurrentSeqForTest()
	keptEdit, _ := json.Marshal(map[string]any{"type": "chat_edited", "payload": map[string]any{"message_id": kept, "channel_id": chID, "content": "kept, edited", "edited_at": "now"}})
	hub.BroadcastToChannel(chID, keptEdit)
	waitFor(t, waitTimeout, func() bool { return hub.CurrentSeqForTest() > seqBefore }, "the kept message's edit to be sequenced")
	if n := framesAbout(hub, keptSet); n != 2 {
		t.Errorf("ring holds %d frames about the kept message, want 2", n)
	}
	// An empty purge is a no-op.
	if err := hub.PurgeMessagesFromReplay(ctx, nil); err != nil {
		t.Errorf("empty purge = %v", err)
	}
}
