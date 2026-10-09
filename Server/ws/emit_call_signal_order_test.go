package ws

// emit_call_signal_order_test.go — regression tests for the call_incoming /
// voice_leave ordering race. CallSignalEvent satisfied only UserTargetedEvent,
// so EmitEvents sent it down the HIGH-priority queue, which writePump drains
// strictly before the normal queue. A caller's voice_leave rides the normal
// queue (async hub dispatch), so a quick leave + re-ring let the new
// call_incoming overtake the older voice_leave: the callee applied the stale
// leave to the new ring, cancelling it (and showing a false "Missed call").

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestEmitEvents_CallSignalEvent_UsesNormalQueue pins the queue half of the
// fix: ring and decline frames share the normal FIFO with voice_leave, never
// the high-priority queue that overtakes it.
func TestEmitEvents_CallSignalEvent_UsesNormalQueue(t *testing.T) {
	h := newEmitTestHub()

	// Distinct channels (not the shared-channel helpers) so a queue split is
	// observable.
	target := &Client{
		hub:      h,
		ctx:      context.Background(),
		userID:   2,
		send:     make(chan []byte, 8),
		sendHigh: make(chan []byte, 8),
		sendLow:  make(chan []byte, 8),
	}
	h.clients[2] = target

	h.EmitEvents(context.Background(), []Event{
		CallSignalEvent{eventType: MsgTypeCallIncoming, targetUserID: 2, payload: []byte(`{"type":"call_incoming"}`)},
		CallSignalEvent{eventType: MsgTypeCallDeclined, targetUserID: 2, payload: []byte(`{"type":"call_declined"}`)},
	})

	if got := len(drainChan(target.sendHigh, 50*time.Millisecond)); got != 0 {
		t.Errorf("call signals must not use the high-priority queue (it overtakes voice_leave); got %d", got)
	}
	if got := len(drainChan(target.send, 50*time.Millisecond)); got != 2 {
		t.Errorf("expected both call signals on the normal queue, got %d", got)
	}
}

// TestEmitEvents_CallIncoming_FollowsEarlierVoiceLeave pins the dispatch half:
// a voice_leave is enqueued on the async hub dispatch queue, so a call_incoming
// emitted afterwards from the handler goroutine must wait for that leave to be
// delivered, or it reaches the callee's queue first.
func TestEmitEvents_CallIncoming_FollowsEarlierVoiceLeave(t *testing.T) {
	h := newEmitTestHub()
	obs := registerEmitTestClient(h, 2, 0) // one channel for every priority: arrival order is observable
	go h.Run()
	defer h.Stop()
	waitUntilRunning(t, h)

	// Stall dispatch so the leave is provably still queued when the ring is
	// emitted.
	h.seqMu.Lock()
	h.broadcastChannelScopedTo(9, []byte(`{"type":"voice_leave"}`), []int64{2}, "voice event")

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.EmitEvents(context.Background(), []Event{
			CallSignalEvent{eventType: MsgTypeCallIncoming, targetUserID: 2, payload: []byte(`{"type":"call_incoming"}`)},
		})
	}()
	time.Sleep(100 * time.Millisecond)
	h.seqMu.Unlock()
	<-done

	msgs := drainChan(obs, 200*time.Millisecond)
	if len(msgs) != 2 || !strings.Contains(string(msgs[0]), "voice_leave") || !strings.Contains(string(msgs[1]), "call_incoming") {
		t.Fatalf("expected voice_leave then call_incoming, got %q", msgs)
	}
}
