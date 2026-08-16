package ws

// emit_presence_others_priority_test.go — regression test for OC-0003: the
// public half of an invisible user's presence (PresenceOthersEvent) went out
// via h.broadcastExcludeLow onto the low-priority queue — the same ephemeral,
// drop-on-overflow, unsequenced transport used for typing indicators — while
// every other source of the same user's presence (connect/disconnect via
// BroadcastToAll, and the visible presence_update path OC-0214 already fixed)
// shares the normal-priority queue. That split one user's presence across two
// per-client FIFOs with different durability and different drain order:
// writePump always drains normal strictly before low, so an observer with an
// older frame on low and a newer one on normal (or vice versa) can end up
// with the wrong one landing last, and a full low-priority queue silently
// drops the frame with no seq bump and no replay recovery — unlike the
// normal-priority queue, which disconnects on overflow and lets replay (or a
// fresh ready) repair the gap.

import (
	"context"
	"testing"
	"time"
)

// TestEmitEvents_PresenceOthersEvent_UsesNormalPriorityQueue pins the fix: a
// PresenceOthersEvent (the public half of an invisible presence change),
// routed through the ExcludeSenderEvent case in EmitEvents, must land on an
// observer's normal-priority queue — the same FIFO every other presence
// source for that user uses — never the low-priority queue, while still never
// reaching the excluded user (the invisible owner) themselves.
//
// Before the fix, emit.go special-cased this case onto h.broadcastExcludeLow,
// so this test observes the frame on the observer's c.sendLow instead of
// c.send, and fails.
func TestEmitEvents_PresenceOthersEvent_UsesNormalPriorityQueue(t *testing.T) {
	h := newEmitTestHub()

	// Built directly (not via the emit_test.go helpers) so send and sendLow
	// are DISTINCT channels — the shared-channel helpers in export_test.go
	// unify them "for test observability" and would mask exactly the
	// queue-split this test needs to detect.
	observer := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   1,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	owner := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   2,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	h.clients[1] = observer
	h.clients[2] = owner
	h.pubsub.Subscribe(observer, TopicGlobal)
	h.pubsub.Subscribe(owner, TopicGlobal)

	// The normal-priority path goes through the async hub.broadcast channel,
	// so the hub loop must be running to deliver it.
	go h.Run()
	defer h.Stop()

	payload := []byte(`{"type":"presence","user_id":2,"status":"offline"}`)
	h.EmitEvents(context.Background(), []Event{
		PresenceOthersEvent{excludeUserID: 2, payload: payload},
	})

	observerNormal := drainChan(observer.send, 200*time.Millisecond)
	observerLow := drainChan(observer.sendLow, 50*time.Millisecond)
	ownerNormal := drainChan(owner.send, 50*time.Millisecond)
	ownerLow := drainChan(owner.sendLow, 50*time.Millisecond)

	if len(observerNormal) != 1 {
		t.Errorf("expected the public half of an invisible presence change on the "+
			"observer's normal-priority queue (same FIFO as connect/disconnect "+
			"presence), got %d normal messages, %d low messages",
			len(observerNormal), len(observerLow))
	}
	if len(observerLow) != 0 {
		t.Errorf("invisible presence's public half must not go out on the "+
			"low-priority queue: writePump drains normal strictly before low, so "+
			"a frame queued there can be delivered after a later connect/"+
			"disconnect presence frame on the normal queue, leaving the "+
			"observer's final view stale, and is silently dropped (no replay "+
			"recovery) on overflow; got %d low messages", len(observerLow))
	}
	if len(ownerNormal) != 0 || len(ownerLow) != 0 {
		t.Errorf("the excluded owner must never receive the public half of "+
			"their own invisible presence change: got %d normal, %d low messages",
			len(ownerNormal), len(ownerLow))
	}
}
