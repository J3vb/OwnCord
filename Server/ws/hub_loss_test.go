package ws

import (
	"context"
	"testing"
	"time"
)

func lossMarked(h *Hub, userID int64) bool {
	c := h.newestLocked(userID)
	return h.presenceResyncPending(userID, "") && c != nil && c.cseq.lossPending.Load()
}

// fillBroadcastQueue leaves the dispatch queue full, so the next frame enqueue
// sees is dropped.
func fillBroadcastQueue(h *Hub) {
	for range cap(h.broadcast) - len(h.broadcast) {
		h.broadcast <- broadcastMsg{msg: []byte(`{"type":"server_filler"}`)}
	}
}

func TestQueueDrop_ChannelRoute_MarksTopicSubscribers(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 6)
	fillBroadcastQueue(h)
	h.BroadcastToChannel(5, []byte(`{"type":"chat_deleted","payload":{"id":1,"channel_id":5}}`))
	drainQueueThroughDispatch(h)

	if !lossMarked(h, 1) {
		t.Fatal("a subscriber of the channel whose frame was dropped is not marked")
	}
	if h.presenceResyncPending(2, "") || h.clients[2][0].cseq.lossPending.Load() {
		t.Fatal("a client of another channel was marked")
	}
	if got := h.LossMarkCount(); got != 1 {
		t.Fatalf("LossMarkCount = %d, want 1", got)
	}
}

func TestQueueDrop_GlobalRoute_MarksAllButExcluded(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 6)
	fillBroadcastQueue(h)
	h.enqueue(broadcastMsg{msg: []byte(`{"type":"member_update"}`), excludeUserID: 2}, "global")
	drainQueueThroughDispatch(h)

	if !lossMarked(h, 1) {
		t.Fatal("a recipient of the dropped global frame is not marked")
	}
	if h.presenceResyncPending(2, "") {
		t.Fatal("the excluded user was marked")
	}
}

func TestQueueDrop_RecipientsRoute(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 5)
	fillBroadcastQueue(h)
	h.enqueue(broadcastMsg{msg: []byte(`{"type":"voice_state"}`), recipients: []int64{2, 99}}, "voice")
	drainQueueThroughDispatch(h)

	if h.presenceResyncPending(1, "") {
		t.Fatal("a user outside the recipient list was marked")
	}
	if !lossMarked(h, 2) {
		t.Fatal("a listed recipient is not marked")
	}
}

// A lost presence batch is repaired by a snapshot (flushPresenceQueue); a
// gap would send every client to a resume for it.
func TestQueueDrop_PresenceBatchMarksNobody(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	fillBroadcastQueue(h)
	h.enqueue(broadcastMsg{droppable: true, msg: []byte(`{"type":"presence_batch"}`)}, "presence_batch")
	drainQueueThroughDispatch(h)

	if h.presenceResyncPending(1, "") || h.clients[1][0].cseq.lossPending.Load() {
		t.Fatal("a dropped presence batch marked a client")
	}
}

func TestQueueDrop_RouteOverflowMarksAll(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 6)
	fillBroadcastQueue(h)
	for range queueDropRouteCap + 1 {
		h.BroadcastToChannel(7, []byte(`{"type":"chat_deleted"}`))
	}
	drainQueueThroughDispatch(h)

	if !lossMarked(h, 1) || !lossMarked(h, 2) {
		t.Fatal("past the route cap every client must be marked")
	}
}

// A content gate that times out withholds the frame from the channel's
// subscribers: they are marked, everyone else is not.
func TestFailedGate_MarksSubscribersOnly(t *testing.T) {
	f := newNSFWGateFixture(t)
	v := newGateBlockingVisibility(f.hub.readers.Visibility, f.labelledID)
	f.hub.readers.Visibility = v
	t.Cleanup(func() { close(v.release) })
	f.hub.gates.timeout = 30 * time.Millisecond
	startNSFWHub(t, f)

	registerEmitTestClient(f.hub, f.aliceID, f.labelledID)
	registerEmitTestClient(f.hub, f.bobID, f.controlID)
	f.hub.enqueue(contentFrame(f.labelledID, "timed out"), "channel content")
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	f.hub.mu.RLock()
	alice, bob := f.hub.newestLocked(f.aliceID), f.hub.newestLocked(f.bobID)
	f.hub.mu.RUnlock()
	if !f.hub.presenceResyncPending(f.aliceID, "") || !alice.cseq.lossPending.Load() {
		t.Fatal("the subscriber the gate withheld the frame from is not marked")
	}
	if f.hub.presenceResyncPending(f.bobID, "") || bob.cseq.lossPending.Load() {
		t.Fatal("a subscriber of another channel was marked")
	}
}

// A resume that passed reconnectPrecheck before a loss was marked for its
// user still takes the full ready at registration.
func TestMustFullResyncAtRegister_LossMarkedForUser(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	h.seqMu.Lock()
	defer h.seqMu.Unlock()
	if h.mustFullResyncAtRegister(0, 1, "") {
		t.Fatal("full resync forced with nothing marked")
	}
	h.markLoss(lossRoute{channelID: 5})
	if !h.mustFullResyncAtRegister(0, 1, "") {
		t.Fatal("a loss marked for the resuming user must force the full ready")
	}
}

// A fresh ready covers every loss marked before it is built: no gap right
// after it. A loss marked after it still gaps.
func TestTakeOwedResync_ClearsLossPending(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	c := h.clients[1][0]
	frame := wrapWithSeq([]byte(`{"type":"typing"}`), 3)

	h.markLoss(lossRoute{channelID: 5})
	if !h.takeOwedResync(c) {
		t.Fatal("takeOwedResync did not report the owed resync")
	}
	if n := cseqOf(t, c.stampCseq(frame)); n != 1 {
		t.Fatalf("first cseq after the fresh ready = %d, want 1", n)
	}
	h.markLoss(lossRoute{channelID: 5})
	if n := cseqOf(t, c.stampCseq(frame)); n != 3 {
		t.Fatalf("cseq after a later loss = %d, want 3", n)
	}
}

// A presence_update frame refused by the full dispatch queue reached nobody;
// the next flush marks every client for a presence snapshot.
func TestPresenceFrameRefused_NextFlushSnapshotsEveryClient(t *testing.T) {
	h := newEmitTestHub()
	registerEmitTestClient(h, 1, 5)
	registerEmitTestClient(h, 2, 6)
	fillBroadcastQueue(h)
	h.broadcastPresenceFrame(0, []byte(`{"type":"presence","payload":{"user_id":3,"status":"idle"}}`))
	if !h.presenceRepair.lostAll.Load() {
		t.Fatal("a refused presence frame was not recorded")
	}
	drainQueueThroughDispatch(h)
	h.flushPresenceQueue()
	if h.presenceRepair.lostAll.Load() {
		t.Fatal("the flush did not take the recorded loss")
	}
	for _, uid := range []int64{1, 2} {
		if !h.clients[uid][0].presenceStale.Load() {
			t.Fatalf("client %d is not marked for a presence snapshot", uid)
		}
	}
}
