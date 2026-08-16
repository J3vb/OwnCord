package ws

// presence_coalesce_flush_race_test.go — regression test for OC-0005.
//
// flushPresenceQueue snapshots h.presenceQueue and releases presenceMu
// BEFORE broadcasting the snapshotted entries. dropQueuedPresence (the guard
// EmitEvents uses to stop a stale connect/disconnect presence from
// clobbering a fresher user-chosen status) only deletes from the LIVE map,
// so a drop that lands after the flush has already taken its snapshot is a
// no-op — and, critically, nothing then constrains the relative order in
// which the flush's stale broadcast and the fresher direct broadcast reach
// h.broadcast. Both go through deliverBroadcast's single FIFO consumer,
// which stamps seq in enqueue order, so whichever one is enqueued LAST wins
// every client's final view. A stale connect-time presence enqueued after a
// user's own fresher presence_update therefore permanently overwrites it.
//
// The snapshot-to-broadcast window is a few instructions wide and not
// reliably landed by staggering real goroutines, so presenceFlushRaceHook
// (test-only, nil in production) fires at exactly that point, mirroring the
// established refreshChannelVisibilityRaceHook / voiceJoinPostTokenRaceHook
// pattern used to pin analogous races elsewhere in this package.

import (
	"bytes"
	"context"
	"testing"
	"time"
)

// TestFlushPresenceQueue_ConcurrentDirectPresenceOrdersLast pins OC-0005 for
// the visible presence_update path (EmitEvents' BroadcastAllEvent branch).
//
// A stale connect-time "online" is queued for user 42. While
// flushPresenceQueue is mid-flush (queue already snapshotted), a concurrent
// presence_update to "dnd" races in via EmitEvents. The fresher "dnd" must
// end up enqueued on h.broadcast AFTER the stale "online" — so the hub
// stamps it with the higher seq and every other client's final view of user
// 42 converges on "dnd", not the stale "online".
func TestFlushPresenceQueue_ConcurrentDirectPresenceOrdersLast(t *testing.T) {
	h := &Hub{
		broadcast: make(chan broadcastMsg, 8),
		pubsub:    NewPubSub(),
	}
	// Populate the queue directly rather than via QueuePresence: QueuePresence
	// arms a real 300ms time.AfterFunc(h.flushPresenceQueue), and this test
	// already drives flushPresenceQueue manually below. Leaving that timer
	// armed would let it fire later — during a *later* run of this same test
	// under -count=N, or during another test entirely — and invoke whatever
	// presenceFlushRaceHook happens to be installed at that later moment,
	// which is exactly the kind of cross-run interference this test must not
	// introduce.
	h.presenceMu.Lock()
	h.presenceQueue = map[int64]pendingPresence{42: {status: "online"}}
	h.presenceFlushArmed = true
	h.presenceMu.Unlock()

	raced := make(chan struct{})
	var hookRan bool
	presenceFlushRaceHook = func() {
		hookRan = true
		// Simulate EmitEvents' direct presence branch racing in exactly
		// here: after flushPresenceQueue has snapshotted (and, currently,
		// released presenceMu for) the queue, but before it has broadcast
		// the stale entry.
		go func() {
			h.EmitEvents(context.Background(), presenceEvents(42, "dnd", nil))
			close(raced)
		}()
		// Give the goroutine room to actually run: with the bug this lets
		// it complete its (unsynchronized) broadcast well before flush's
		// own loop runs; with the fix in place the goroutine instead blocks
		// on presenceMu until this function returns and releases it, so the
		// sleep costs nothing extra there either way.
		time.Sleep(20 * time.Millisecond)
	}
	defer func() { presenceFlushRaceHook = nil }()

	h.flushPresenceQueue()
	<-raced

	if !hookRan {
		t.Fatal("presenceFlushRaceHook never fired — test setup is broken, not exercising the flush race window")
	}

	if len(h.broadcast) != 2 {
		t.Fatalf("expected 2 broadcast frames (stale flush + fresh update), got %d", len(h.broadcast))
	}
	first := <-h.broadcast
	second := <-h.broadcast

	if !bytes.Contains(first.msg, []byte(`"status":"online"`)) {
		t.Errorf("expected the stale flush's 'online' frame enqueued FIRST; got first=%s", first.msg)
	}
	if !bytes.Contains(second.msg, []byte(`"status":"dnd"`)) {
		t.Errorf("expected the fresh presence_update's 'dnd' frame enqueued LAST (so it gets the higher seq and wins); got second=%s", second.msg)
	}
}
