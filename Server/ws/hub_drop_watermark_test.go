package ws

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// drainQueueThroughDispatch delivers every frame waiting on h.broadcast, as
// the dispatch loop would.
func drainQueueThroughDispatch(h *Hub) {
	for {
		select {
		case bm := <-h.broadcast:
			h.deliverBroadcast(bm)
		default:
			return
		}
	}
}

// A metadata frame dropped by a full broadcast queue would have been
// sequenced and replayable, so its loss must force a resuming client onto
// the full-ready path just as a lost chat_message does (2A-4).
func TestQueueDrop_MetadataFrameForcesResync(t *testing.T) {
	h := newEmitTestHub()
	for range cap(h.broadcast) {
		h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	}
	h.BroadcastToChannel(5, []byte(`{"type":"chat_deleted","payload":{"id":1,"channel_id":5}}`))
	if got := h.BroadcastDropCount(); got != 1 {
		t.Fatalf("BroadcastDropCount = %d, want 1", got)
	}

	drainQueueThroughDispatch(h)
	last := atomic.LoadUint64(&h.seq)
	if !h.mustFullResync(last) {
		t.Fatalf("a client that received every frame up to seq %d missed the dropped chat_deleted and must take the full-ready path", last)
	}
	if h.queueDrops.applied != h.queueDrops.dropped.Load() {
		t.Fatal("the drop must settle once the queue has drained")
	}
}

// A presence snapshot request carries no frame and is retried by
// flushPresenceQueue, so dropping it does not force anyone to resync.
func TestQueueDrop_PresenceSnapshotRequestDoesNotForceResync(t *testing.T) {
	h := newEmitTestHub()
	for range cap(h.broadcast) {
		h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	}
	if h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot") {
		t.Fatal("enqueue on a full queue reported success")
	}
	drainQueueThroughDispatch(h)
	if last := atomic.LoadUint64(&h.seq); h.mustFullResync(last) {
		t.Fatalf("a dropped snapshot request forced a full resync at seq %d", last)
	}
}

// A content frame meeting a full queue waits for room instead of dropping at
// once, so a short burst costs nobody a resync.
func TestEnqueue_ContentFrameWaitsForRoom(t *testing.T) {
	h := newEmitTestHub()
	for range cap(h.broadcast) {
		h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	}
	done := make(chan bool, 1)
	go func() {
		done <- h.enqueue(broadcastMsg{channelID: 5, nsfwChannelID: 5, msg: []byte(`{"type":"chat_message"}`)}, "channel content")
	}()
	select {
	case <-done:
		t.Fatal("a content frame returned at once from a full queue instead of waiting")
	case <-time.After(50 * time.Millisecond):
	}
	<-h.broadcast
	select {
	case ok := <-done:
		if !ok {
			t.Fatal("the content frame was dropped although room opened inside the wait")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting content frame never took the freed slot")
	}
	if got := h.BroadcastDropCount(); got != 0 {
		t.Fatalf("BroadcastDropCount = %d, want 0", got)
	}
}

// A metadata frame never waits: its producers include the hub's own timers.
func TestEnqueue_MetadataFrameDoesNotWait(t *testing.T) {
	h := newEmitTestHub()
	for range cap(h.broadcast) {
		h.BroadcastToAll([]byte(`{"type":"server_filler"}`))
	}
	start := time.Now()
	h.BroadcastToChannel(5, []byte(`{"type":"chat_deleted"}`))
	if waited := time.Since(start); waited > contentEnqueueWait/2 {
		t.Fatalf("a metadata enqueue on a full queue took %v", waited)
	}
}

// When the content gate cannot read the channel, it withholds the frame from
// every subscriber; a resume at or behind that frame must take the full-ready
// path so the message is refetched from the database (2A-4).
func TestNSFWGateLookupFailure_ForcesResync(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()
	subscriberID, err := database.CreateUser(ctx, "gate-fail-subscriber", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "gate-fail-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	hub := newTestHubWith(t, HubOptions{
		DB:      database,
		Limiter: auth.NewRateLimiter(),
		Readers: HubReaders{
			Visibility: &erroringGetChannelReader{VisibilityReader: database},
			Ready:      database,
			Members:    database,
			Dispatch:   database,
		},
	})
	go hub.Run()
	t.Cleanup(hub.Stop)
	waitUntilRunning(t, hub)

	c := NewTestClient(hub, subscriberID, make(chan []byte, 8))
	hub.mu.Lock()
	hub.clients[subscriberID] = c
	hub.mu.Unlock()
	hub.pubsub.Subscribe(c, ChannelTopic(chID))

	before := atomic.LoadUint64(&hub.seq)
	if hub.mustFullResync(before) {
		t.Fatalf("seq %d already forces a full resync before the test frame", before)
	}
	payload, _ := json.Marshal(map[string]any{
		"type":    MsgTypeChatMessage,
		"payload": map[string]any{"channel_id": chID, "content": "withheld"},
	})
	hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: chID, payload: payload}})
	if err := hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	if !hub.mustFullResync(before) {
		t.Fatalf("a client whose last frame was seq %d missed the withheld message and must take the full-ready path", before)
	}
}
