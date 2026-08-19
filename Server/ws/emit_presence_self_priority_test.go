package ws

// emit_presence_self_priority_test.go — regression test for OC-0166: the
// private half of an invisible user's presence (PresenceSelfEvent) satisfies
// UserTargetedEvent, so EmitEvents routed it through h.SendToUserHigh onto the
// HIGH-priority queue, while every other source of that same user's own
// presence — the visible presence_update path (PresenceEvent -> BroadcastToAll)
// and the connect/disconnect coalescer's private half
// (BroadcastPresence -> h.SendToUser) — shares the NORMAL-priority queue.
// writePump always drains high strictly before normal (serve_pumps.go), so a
// newer invisible self-frame queued on high can reach the socket ahead of an
// older visible-status frame still sitting on normal, leaving the owner's own
// client showing a stale status. This is the same split-FIFO hazard OC-0003 /
// OC-0214 fixed for the "others" half of presence; this pins the self half.

import (
	"context"
	"testing"
	"time"
)

// TestEmitEvents_PresenceSelfEvent_UsesNormalPriorityQueue pins the fix: a
// PresenceSelfEvent, routed through EmitEvents, must land on the owner's
// normal-priority queue — the same FIFO every other source of that user's own
// presence uses — never the high-priority queue.
//
// Before the fix, PresenceSelfEvent fell through to the UserTargetedEvent
// case in emit.go and was sent via h.SendToUserHigh, so this test observes
// the frame on c.sendHigh instead of c.send, and fails.
func TestEmitEvents_PresenceSelfEvent_UsesNormalPriorityQueue(t *testing.T) {
	h := newEmitTestHub()

	// Built directly (not via the emit_test.go helpers) so send and sendHigh
	// are DISTINCT channels — the shared-channel helpers in export_test.go
	// unify them "for test observability" and would mask exactly the
	// queue-split this test needs to detect.
	owner := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   1,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	h.clients[1] = owner

	payload := []byte(`{"type":"presence","user_id":1,"status":"invisible"}`)
	h.EmitEvents(context.Background(), []Event{
		PresenceSelfEvent{targetUserID: 1, payload: payload},
	})

	normalMsgs := drainChan(owner.send, 200*time.Millisecond)
	highMsgs := drainChan(owner.sendHigh, 50*time.Millisecond)

	if len(normalMsgs) != 1 {
		t.Errorf("expected the private half of an invisible presence change on "+
			"the owner's normal-priority queue (same FIFO as the visible "+
			"presence_update path and the connect/disconnect coalescer's "+
			"private half), got %d normal messages, %d high messages",
			len(normalMsgs), len(highMsgs))
	}
	if len(highMsgs) != 0 {
		t.Errorf("invisible presence's private half must not go out on the "+
			"high-priority queue: writePump drains high strictly before "+
			"normal, so a newer self-frame queued there can be delivered "+
			"before an older visible-status frame still sitting on normal, "+
			"leaving the owner's own view stale; got %d high messages",
			len(highMsgs))
	}
}
