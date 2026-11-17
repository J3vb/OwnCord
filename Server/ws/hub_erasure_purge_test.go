package ws

import (
	"context"
	"errors"
	"testing"
)

func erasureColdReadsOff(t *testing.T, h *Hub) bool {
	t.Helper()
	store := *h.events.eventStore.Load()
	_, err := store.GetEventsSince(context.Background(), 0, 10)
	return errors.Is(err, errReplayPurgeInProgress)
}

// A failed erasure purge keeps cold reads off until the same job's retry succeeds, even
// though the first attempt already dropped the ring copies the retry would have read.
func TestPurgeErasedMessages_FailedAttemptKeepsColdReadsOffUntilRetried(t *testing.T) {
	h := newTestHubWith(t, HubOptions{DB: newTeardownTestDB(t)})
	h.SetEventStore(h.db)
	h.replayBuf.Push(1, 1, []byte(`{"seq":1,"type":"chat_edited","payload":{"id":5,"content":"x"}}`))

	ctx, cancel := context.WithCancel(context.Background())
	setReplayPurgeBeforeDelete(t, cancel)
	if err := h.PurgeErasedMessagesFromReplay(ctx, 7); err == nil {
		t.Fatal("purge with a context canceled before the delete: want an error")
	}
	replayPurgeBeforeDelete = nil
	if !erasureColdReadsOff(t, h) {
		t.Fatal("cold reads stayed on after a failed purge")
	}
	if n := len(h.replayBuf.MessageIDs()); n != 0 {
		t.Fatalf("ring still names %d messages after the failed attempt", n)
	}
	if err := h.PurgeErasedMessagesFromReplay(context.Background(), 7); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if erasureColdReadsOff(t, h) {
		t.Fatal("cold reads stayed off after the retry succeeded")
	}
}

// With nothing in the ring there are no message ids to key the marker by; a failed sweep
// still keeps cold reads off.
func TestPurgeErasedMessages_EmptyRingFailedSweepKeepsColdReadsOff(t *testing.T) {
	h := newTestHubWith(t, HubOptions{DB: newTeardownTestDB(t)})
	h.SetEventStore(h.db)

	ctx, cancel := context.WithCancel(context.Background())
	setReplayPurgeBeforeDelete(t, cancel)
	if err := h.PurgeErasedMessagesFromReplay(ctx, 7); err == nil {
		t.Fatal("purge with a context canceled before the sweep: want an error")
	}
	replayPurgeBeforeDelete = nil
	if !erasureColdReadsOff(t, h) {
		t.Fatal("cold reads stayed on after a failed sweep")
	}
	if err := h.PurgeErasedMessagesFromReplay(context.Background(), 7); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if erasureColdReadsOff(t, h) {
		t.Fatal("cold reads stayed off after the retry succeeded")
	}
}
