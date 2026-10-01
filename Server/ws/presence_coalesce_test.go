package ws

import (
	"bytes"
	"testing"
)

// TestQueuePresence_CoalescesLatestWins locks the coalescer's contract: a
// flap (multiple queued states for one user inside the window) flushes as its
// latest state, and every user that changed rides ONE presence_batch.
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

	if got := len(h.broadcast); got != 1 {
		t.Fatalf("flushed %d broadcasts, want 1 (one batch)", got)
	}
	batch := (<-h.broadcast).presence
	if len(batch) != 2 || batch[1].status != "online" || batch[2].status != "offline" {
		t.Fatalf("batch = %+v, want user 1 online (the flap's latest) and user 2 offline", batch)
	}
	msg, _ := h.buildPresenceBatch(batch)
	if !bytes.Contains(msg, []byte(`"type":"presence_batch"`)) || bytes.Count(msg, []byte(`"user_id"`)) != 2 {
		t.Fatalf("frame = %s, want one presence_batch with two entries", msg)
	}

	// The flush disarms the timer state — a later queue+flush works again.
	h.QueuePresence(1, "idle", nil)
	h.flushPresenceQueue()
	if got := len(h.broadcast); got != 1 {
		t.Fatalf("second cycle flushed %d broadcasts, want 1", got)
	}
}
