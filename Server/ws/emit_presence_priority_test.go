package ws

// emit_presence_priority_test.go — regression test for OC-0214: handler-driven
// presence (presence_update, from PresenceEvent) used to go out on the
// low-priority send queue via BroadcastToAllLow, while connect/disconnect
// presence for the very same user goes out on the normal-priority queue via
// BroadcastToAll. writePump always drains normal strictly before low, so an
// observer with both queued ends up seeing whichever frame happens to be
// normal-priority last, regardless of which one is actually newer — the two
// sources of truth for one user's presence were never in a single FIFO
// together. BroadcastAllEvent's own doc comment (event.go) says it "routes to
// Hub.BroadcastToAll"; PresenceEvent silently violated that.

import (
	"context"
	"testing"
	"time"
)

// TestEmitEvents_PresenceEvent_UsesNormalPriorityQueue pins the fix: a
// handler-driven PresenceEvent routed through the BroadcastAllEvent case must
// land on the client's normal-priority queue (the same one connect/disconnect
// presence uses via hub.BroadcastToAll), never on the low-priority queue.
//
// Before the fix, emit.go special-cased PresenceEvent onto
// h.BroadcastToAllLow, so this test observes the frame on c.sendLow instead
// of c.send and fails.
func TestEmitEvents_PresenceEvent_UsesNormalPriorityQueue(t *testing.T) {
	h := newEmitTestHub()

	// Built directly (not via the emit_test.go helpers) so send and sendLow
	// are DISTINCT channels — the shared-channel helpers in export_test.go are
	// unified "for test observability" and would mask exactly the queue-split
	// this test needs to detect.
	c := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   1,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	h.clients[1] = c
	h.pubsub.Subscribe(c, TopicGlobal)

	// BroadcastToAll (normal priority) goes through the async hub.broadcast
	// channel, so the hub loop must be running to deliver it.
	go h.Run()
	defer h.Stop()

	payload := []byte(`{"type":"presence_update","user_id":1,"status":"idle"}`)
	h.EmitEvents(context.Background(), []Event{PresenceEvent{payload: payload}})

	normalMsgs := drainChan(c.send, 200*time.Millisecond)
	lowMsgs := drainChan(c.sendLow, 50*time.Millisecond)

	if len(normalMsgs) != 1 {
		t.Errorf("expected handler-driven presence on the normal-priority queue "+
			"(same FIFO as connect/disconnect presence), got %d normal messages, %d low messages",
			len(normalMsgs), len(lowMsgs))
	}
	if len(lowMsgs) != 0 {
		t.Errorf("handler-driven presence must not go out on the low-priority queue: "+
			"writePump drains normal strictly before low, so a presence_update queued "+
			"there can be delivered after a later connect/disconnect presence frame on "+
			"the normal queue, leaving the observer's final view stale; got %d low messages",
			len(lowMsgs))
	}
}
