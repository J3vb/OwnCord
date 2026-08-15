package ws

import (
	"bytes"
	"testing"
)

// TestQueuePresence_CoalescesLatestWins locks the coalescer's contract: a
// flap (multiple queued states for one user inside the window) flushes as ONE
// broadcast carrying the latest state, and distinct users each get their own.
func TestQueuePresence_CoalescesLatestWins(t *testing.T) {
	h := &Hub{broadcast: make(chan broadcastMsg, 16)}

	h.QueuePresence(1, "offline", nil)
	h.QueuePresence(1, "online", nil) // same user: latest wins
	h.QueuePresence(2, "offline", nil)

	// Nothing may reach the broadcast queue before the flush.
	if got := len(h.broadcast); got != 0 {
		t.Fatalf("broadcasts before flush = %d, want 0 (coalesced)", got)
	}

	h.flushPresenceQueue()

	var frames [][]byte
	for len(h.broadcast) > 0 {
		frames = append(frames, (<-h.broadcast).msg)
	}
	if len(frames) != 2 {
		t.Fatalf("flushed %d broadcasts, want 2 (one per user)", len(frames))
	}
	sawUser1Online := false
	for _, f := range frames {
		if bytes.Contains(f, []byte(`"user_id":1`)) {
			if bytes.Contains(f, []byte("offline")) {
				t.Fatalf("user 1's flap flushed the stale state: %s", f)
			}
			sawUser1Online = bytes.Contains(f, []byte("online"))
		}
	}
	if !sawUser1Online {
		t.Fatal("user 1's latest (online) presence was not flushed")
	}

	// The flush disarms the timer state — a later queue+flush works again.
	h.QueuePresence(1, "idle", nil)
	h.flushPresenceQueue()
	if got := len(h.broadcast); got != 1 {
		t.Fatalf("second cycle flushed %d broadcasts, want 1", got)
	}
}
