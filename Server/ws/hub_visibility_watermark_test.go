package ws

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/owncord/server/db"
)

// TestBumpVisibilityWatermark_RatchetsUpwardOnly locks the core invariant all
// three visibilityChangeSeq writers now depend on: the watermark only ever
// moves forward, mirroring SeedSeq's CAS-max pattern. Before the fix, every
// writer did a plain Store(Load(&h.seq)), so a writer that observed an older
// h.seq could clobber a watermark another writer had already pushed higher.
func TestBumpVisibilityWatermark_RatchetsUpwardOnly(t *testing.T) {
	h := &Hub{}

	atomic.StoreUint64(&h.seq, 100)
	h.bumpVisibilityWatermark()
	if got := h.visibilityChangeSeq.Load(); got != 100 {
		t.Fatalf("watermark = %d, want 100", got)
	}

	// A later caller observing a LOWER h.seq (e.g. a writer that read it
	// before a concurrent bump advanced it further) must not regress the
	// watermark another writer already pushed higher.
	atomic.StoreUint64(&h.seq, 50)
	h.bumpVisibilityWatermark()
	if got := h.visibilityChangeSeq.Load(); got != 100 {
		t.Fatalf("watermark regressed to %d after a lower bump, want it to stay at 100", got)
	}

	// A genuine advance still moves the watermark forward.
	atomic.StoreUint64(&h.seq, 150)
	h.bumpVisibilityWatermark()
	if got := h.visibilityChangeSeq.Load(); got != 150 {
		t.Fatalf("watermark = %d after a genuine advance, want 150", got)
	}
}

// TestBumpVisibilityWatermark_ConcurrentCallsNeverRegress hammers the ratchet
// from many goroutines with h.seq advancing concurrently and asserts the
// final watermark is never below any value observed mid-run — i.e. it only
// ever moves forward, regardless of goroutine interleaving.
func TestBumpVisibilityWatermark_ConcurrentCallsNeverRegress(t *testing.T) {
	h := &Hub{}
	atomic.StoreUint64(&h.seq, 1)

	const goroutines = 32
	done := make(chan struct{})
	for range goroutines {
		go func() {
			defer func() { done <- struct{}{} }()
			atomic.AddUint64(&h.seq, 1)
			h.bumpVisibilityWatermark()
		}()
	}
	for range goroutines {
		<-done
	}

	finalSeq := atomic.LoadUint64(&h.seq)
	if got := h.visibilityChangeSeq.Load(); got != finalSeq {
		t.Fatalf("watermark = %d after concurrent bumps, want %d (the final seq)", got, finalSeq)
	}
}

// TestMarkVisibilityChanged_BumpsWatermarkLikeInternalWriters pins OC-0013:
// api.markDMVisibilityChanged reaches this bump through a type assertion on
// an exported MarkVisibilityChanged() method — the same watermark the three
// internal writers above ratchet via bumpVisibilityWatermark. Without an
// exported wrapper, the assertion in api/dm_handler.go always misses against
// the real *ws.Hub, so a REST-originated DM event (group create, rename,
// close, group-leave) never bumps the watermark and a client that warm-
// reconnects across it is wrongly admitted onto the replay path — which
// cannot carry the unsequenced, targeted dm_channel_open/close those REST
// handlers send.
func TestMarkVisibilityChanged_BumpsWatermarkLikeInternalWriters(t *testing.T) {
	h := &Hub{}
	atomic.StoreUint64(&h.seq, 42)

	h.MarkVisibilityChanged()

	if got := h.visibilityChangeSeq.Load(); got != 42 {
		t.Fatalf("visibilityChangeSeq = %d after MarkVisibilityChanged, want 42", got)
	}
	if !h.mustFullResync(42) {
		t.Error("a client resuming from a seq at or before the REST DM event must be forced onto the full-ready path")
	}
	if h.mustFullResync(43) {
		t.Error("clients past the change must keep replaying normally")
	}
}

// TestRevokeUnreadableChannels_WatermarkNeverRegresses targets the specific
// defect: revokeUnreadableChannels used `defer h.visibilityChangeSeq.Store(atomic.LoadUint64(&h.seq))`,
// whose argument Go evaluates at the DEFER STATEMENT (function entry), not at
// the deferred call (function exit) — so it stored a stale entry-time seq,
// silently overwriting any higher watermark a concurrent writer (e.g. a DM
// open) stored while this function did its per-topic DB work. Simulated here
// by pre-seeding the watermark above h.seq, standing in for "a concurrent
// writer already pushed the watermark past this function's entry-time seq".
func TestRevokeUnreadableChannels_WatermarkNeverRegresses(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 100)
	// Simulate a concurrent writer (DMChannelOpenEvent) that already bumped
	// the watermark past the current seq before this call starts.
	h.visibilityChangeSeq.Store(500)

	// h.db is nil, so revokeUnreadableChannels returns immediately after the
	// deferred bump runs — exercising exactly the regression path.
	h.revokeUnreadableChannels(1)

	if got := h.visibilityChangeSeq.Load(); got != 500 {
		t.Fatalf("watermark = %d after revokeUnreadableChannels, want it to stay at 500 (must not regress)", got)
	}
}

// TestRefreshChannelVisibility_WatermarkNeverRegresses is RefreshChannelVisibility's
// counterpart to the above: its trailing watermark bump must also ratchet
// upward only, not clobber a higher value a concurrent writer already stored.
func TestRefreshChannelVisibility_WatermarkNeverRegresses(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 100)
	h.visibilityChangeSeq.Store(500)

	h.RefreshChannelVisibility(&db.Channel{ID: 1, Type: "text"})

	if got := h.visibilityChangeSeq.Load(); got != 500 {
		t.Fatalf("watermark = %d after RefreshChannelVisibility, want it to stay at 500 (must not regress)", got)
	}
}

// TestEmitEvents_DMChannelOpen_WatermarkNeverRegresses is emit.go's
// UserTargetedEvent/DMChannelOpenEvent branch's counterpart: it must also
// route through the same upward-only ratchet instead of a plain Store.
func TestEmitEvents_DMChannelOpen_WatermarkNeverRegresses(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 100)
	h.visibilityChangeSeq.Store(500)

	h.EmitEvents(context.Background(), []Event{
		DMChannelOpenEvent{targetUserID: 7, payload: []byte(`{"type":"dm_channel_open"}`)},
	})

	if got := h.visibilityChangeSeq.Load(); got != 500 {
		t.Fatalf("watermark = %d after DMChannelOpenEvent, want it to stay at 500 (must not regress)", got)
	}
}

// Sanity check that the ratchet does not break the original, non-racing
// behaviour these functions must still provide: a genuine, later seq still
// moves the watermark forward so mustFullResync keeps working.
func TestEmitEvents_DMChannelOpen_WatermarkStillAdvances(t *testing.T) {
	h := newEmitTestHub()
	atomic.StoreUint64(&h.seq, 40)

	h.EmitEvents(context.Background(), []Event{
		DMChannelOpenEvent{targetUserID: 7, payload: []byte(`{"type":"dm_channel_open"}`)},
	})

	if !h.mustFullResync(40) {
		t.Error("a client resuming from a seq at or before a dm_channel_open must be forced onto the full-ready path")
	}
	if h.mustFullResync(41) {
		t.Error("clients past the open must keep replaying normally")
	}
}
