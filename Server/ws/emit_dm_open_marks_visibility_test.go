package ws

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// The socket path of a DM open takes seqMu like MarkVisibilityChanged does, so it cannot slip between a
// reconnecting socket's watermark re-check and its registration.
func TestEmitUserTargeted_DMChannelOpen_WaitsForSeqMu(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 100)

	h.seqMu.Lock()
	done := make(chan struct{})
	go func() {
		h.emitUserTargeted(context.Background(), 0, DMChannelOpenEvent{targetUserID: 7, payload: []byte(`{"type":"dm_channel_open"}`)})
		close(done)
	}()
	select {
	case <-done:
		h.seqMu.Unlock()
		t.Fatal("emitUserTargeted finished while seqMu was held; it must take seqMu to mark visibility")
	case <-time.After(100 * time.Millisecond):
	}
	h.seqMu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("emitUserTargeted did not finish after seqMu was released")
	}
	if got := h.visibilityChangeSeq.Load(); got != 100 {
		t.Fatalf("watermark = %d, want 100", got)
	}
}
