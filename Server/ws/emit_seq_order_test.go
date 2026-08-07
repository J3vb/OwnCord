package ws

import (
	"context"
	"testing"
)

// A seq-stamped frame must never ride the high-priority queue: writePump
// drains sendHigh to exhaustion before send, so a sequenced DM would reach
// the socket ahead of lower-seq events still queued in send. The client acks
// max(seq) and replay is strictly seq > last_seq, so a disconnect in that
// window silently and permanently loses the overtaken events. All sequenced
// frames must share the one per-client FIFO.
func TestEmitSequencedDM_UsesNormalQueueToPreserveSeqOrder(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 8)
	sendHigh := make(chan []byte, 8)
	c := NewTestClientWithChannel(h, 42, 0, send)
	c.sendHigh = sendHigh // split queues so the test can see which one delivers
	h.clients[42] = c
	h.pubsub.Subscribe(c, UserTopic(42))

	h.EmitEvents(context.Background(), []Event{stubSequencedDMEvent{
		channelID:      7,
		participantIDs: []int64{42},
		payload:        []byte(`{"type":"test_dm"}`),
	}})

	if got := len(sendHigh); got != 0 {
		t.Fatalf("sequenced DM rode the high-priority queue (%d frames); it can overtake lower-seq events", got)
	}
	if got := len(send); got != 1 {
		t.Fatalf("sequenced DM not delivered on the normal FIFO: got %d frames, want 1", got)
	}
}

// Unsequenced targeted events (DM opens, voice tokens) carry no seq, so the
// high-priority fast lane stays correct for them.
func TestEmitUserTargeted_KeepsHighPriorityFastLane(t *testing.T) {
	h := newEmitTestHub()
	send := make(chan []byte, 8)
	sendHigh := make(chan []byte, 8)
	c := NewTestClientWithChannel(h, 42, 0, send)
	c.sendHigh = sendHigh
	h.clients[42] = c

	h.EmitEvents(context.Background(), []Event{stubUserTargetedEvent{
		targetUserID: 42,
		payload:      []byte(`{"type":"test_targeted"}`),
	}})

	if got := len(sendHigh); got != 1 {
		t.Fatalf("unsequenced targeted event should use the high-priority queue: got %d frames, want 1", got)
	}
}
