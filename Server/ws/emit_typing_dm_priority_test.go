package ws

// emit_typing_dm_priority_test.go — regression test for OC-0260: TypingDMEvent
// (the DM half of typing_start) satisfies only UserTargetedEvent, so EmitEvents
// routed it through h.SendToUserHigh onto the HIGH-priority queue, whose
// overflow fallback disconnects the client (client.go sendHighMsg ->
// closeAllSendLocked). Its channel sibling, TypingChannelEvent, satisfies
// ExcludeSenderEvent and is routed to the LOW-priority queue (sendLowMsg),
// which silently drops on overflow instead of disconnecting — the correct,
// documented behavior for an ephemeral typing indicator (handlers.go's
// broadcastExcludeLow doc: "correct for typing indicators (dropped on
// overflow instead of disconnecting)"). The identical event therefore had the
// strictest durability class in a DM and the most droppable one in a channel,
// and a busy DM typer could disconnect a backpressured recipient over a
// cosmetic frame. This pins the fix: TypingDMEvent must land on the
// low-priority queue, never the high-priority one.

import (
	"context"
	"testing"
	"time"
)

// TestEmitEvents_TypingDMEvent_UsesLowPriorityQueue pins the fix: a
// TypingDMEvent, routed through EmitEvents, must land on the target's
// low-priority queue (dropped on overflow, like TypingChannelEvent) — never
// the high-priority queue (whose overflow fallback disconnects the client).
//
// Before the fix, TypingDMEvent fell through to the UserTargetedEvent case in
// emit.go and was sent via h.SendToUserHigh, so this test observes the frame
// on c.sendHigh instead of c.sendLow, and fails.
func TestEmitEvents_TypingDMEvent_UsesLowPriorityQueue(t *testing.T) {
	h := newEmitTestHub()

	// Built directly (not via the emit_test.go helpers) so send, sendHigh, and
	// sendLow are DISTINCT channels — the shared-channel helpers in
	// export_test.go unify them "for test observability" and would mask
	// exactly the queue-split this test needs to detect.
	target := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   2,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	h.clients[2] = target

	payload := []byte(`{"type":"typing","channel_id":9,"user_id":1}`)
	h.EmitEvents(context.Background(), []Event{
		TypingDMEvent{targetUserID: 2, payload: payload},
	})

	lowMsgs := drainChan(target.sendLow, 200*time.Millisecond)
	highMsgs := drainChan(target.sendHigh, 50*time.Millisecond)

	if len(lowMsgs) != 1 {
		t.Errorf("expected DM typing indicator on the target's low-priority "+
			"queue (same droppable-on-overflow class as TypingChannelEvent), "+
			"got %d low messages, %d high messages", len(lowMsgs), len(highMsgs))
	}
	if len(highMsgs) != 0 {
		t.Errorf("DM typing indicator must not go out on the high-priority "+
			"queue: on overflow its fallback chain disconnects the client "+
			"(client.go sendHighMsg -> closeAllSendLocked), which is the wrong "+
			"durability class for a cosmetic ephemeral frame; got %d high messages",
			len(highMsgs))
	}
}

// TestEmitEvents_TypingDMEvent_DropsRatherThanDisconnectsOnOverflow pins the
// disconnect-avoidance half of the fix directly: fill both the high and
// normal queues (the old failure path required both full before
// disconnecting) and confirm a TypingDMEvent on top does not close the
// client's send side.
func TestEmitEvents_TypingDMEvent_DropsRatherThanDisconnectsOnOverflow(t *testing.T) {
	h := newEmitTestHub()

	target := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   3,
		send:     make(chan []byte, 1),
		sendHigh: make(chan []byte, 1),
		sendLow:  make(chan []byte, 1),
	}
	// Fill both send and sendHigh so the old UserTargetedEvent route
	// (sendHighMsg -> fallback to send -> closeAllSendLocked) would trip.
	target.send <- []byte("normal-filler")
	target.sendHigh <- []byte("high-filler")
	h.clients[3] = target

	payload := []byte(`{"type":"typing","channel_id":9,"user_id":1}`)
	h.EmitEvents(context.Background(), []Event{
		TypingDMEvent{targetUserID: 3, payload: payload},
	})

	if target.isSendClosed() {
		t.Error("TypingDMEvent must not disconnect the client on backpressure " +
			"overflow — it should route to the low-priority queue and be " +
			"silently dropped instead, exactly like TypingChannelEvent")
	}
}
