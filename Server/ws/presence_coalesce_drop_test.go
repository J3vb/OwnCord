package ws

import (
	"context"
	"testing"
)

// TestEmitEvents_DirectPresenceDropsQueuedEntry locks the coalescer-inversion
// fix: a user-chosen presence_update broadcast must invalidate any queued
// connect-time presence for the same user, or the coalescer's later flush
// (up to 300ms) would overwrite the fresh status with the stale one.
func TestEmitEvents_DirectPresenceDropsQueuedEntry(t *testing.T) {
	h := &Hub{
		broadcast: make(chan broadcastMsg, 8),
		pubsub:    NewPubSub(),
	}

	// Simulate connect: queue the connect-time presence.
	h.QueuePresence(7, "online", nil)
	h.presenceMu.Lock()
	_, queued := h.presenceQueue[7]
	h.presenceMu.Unlock()
	if !queued {
		t.Fatal("QueuePresence did not queue the entry")
	}

	// The user immediately sets a status via presence_update (visible path).
	h.EmitEvents(context.Background(), presenceEvents(7, "dnd", nil))

	h.presenceMu.Lock()
	_, stillQueued := h.presenceQueue[7]
	h.presenceMu.Unlock()
	if stillQueued {
		t.Fatal("direct presence broadcast left the stale queued entry; flush would overwrite the fresh status")
	}

	// The invisible path must drop it too (public half rides PresenceOthersEvent).
	h.QueuePresence(7, "online", nil)
	h.EmitEvents(context.Background(), presenceEvents(7, "invisible", nil))
	h.presenceMu.Lock()
	_, stillQueued = h.presenceQueue[7]
	h.presenceMu.Unlock()
	if stillQueued {
		t.Fatal("invisible presence broadcast left the stale queued entry")
	}

	// Other users' queued entries are untouched.
	h.QueuePresence(8, "online", nil)
	h.EmitEvents(context.Background(), presenceEvents(7, "idle", nil))
	h.presenceMu.Lock()
	_, otherKept := h.presenceQueue[8]
	h.presenceMu.Unlock()
	if !otherKept {
		t.Fatal("dropQueuedPresence removed an unrelated user's entry")
	}
}
