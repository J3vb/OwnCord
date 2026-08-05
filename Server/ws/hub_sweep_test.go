package ws

import (
	"sync/atomic"
	"testing"
	"time"
)

// TestStartSweep_NeverRunsConcurrentlyWithItself locks the in-flight guard
// shut: while one sweep is still running, further startSweep calls for the
// same guard must be dropped, and once it finishes the next call runs again.
func TestStartSweep_NeverRunsConcurrentlyWithItself(t *testing.T) {
	h := &Hub{}

	var inFlight atomic.Bool
	var active, maxActive, runs atomic.Int64
	release := make(chan struct{})

	sweep := func() {
		cur := active.Add(1)
		if cur > maxActive.Load() {
			maxActive.Store(cur)
		}
		runs.Add(1)
		<-release
		active.Add(-1)
	}

	// First call claims the guard; the sweep blocks on release.
	h.startSweep(&inFlight, sweep)
	// Wait until the goroutine is actually inside the sweep.
	for active.Load() == 0 {
		time.Sleep(time.Millisecond)
	}

	// Ticks arriving mid-sweep must be dropped, not stacked.
	for range 5 {
		h.startSweep(&inFlight, sweep)
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("runs = %d while first sweep still in flight, want 1", got)
	}

	close(release)
	for inFlight.Load() {
		time.Sleep(time.Millisecond)
	}

	// Guard released — the next tick runs a fresh sweep.
	done := make(chan struct{})
	h.startSweep(&inFlight, func() { close(done) })
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("sweep did not run after the previous one finished")
	}

	if got := maxActive.Load(); got != 1 {
		t.Fatalf("max concurrent sweeps = %d, want 1", got)
	}
	if got := runs.Load(); got != 1 {
		t.Fatalf("blocking sweep ran %d times, want 1", got)
	}
}

// Every kick path (the sweeps, the handlers.go expiry/ban kicks, DisconnectUser)
// deletes the hub entry via kickClient, so the readPump defer's unregisterNow
// finds nothing. "Absent" is a real disconnect, not a replacement: reporting it
// as replaced makes readPump skip MarkUserDisconnected, the offline presence
// broadcast, and handleVoiceLeave, so peers keep rendering the kicked user
// online.
func TestUnregisterNow_KickedClientIsNotReportedAsReplaced(t *testing.T) {
	h := newEmitTestHub()
	c := NewTestClient(h, 1, make(chan []byte, 4))
	h.clients[1] = c

	h.kickClient(c)

	if replaced := h.unregisterNow(c); replaced {
		t.Error("unregisterNow(kicked client) = true (replaced), want false (real disconnect)")
	}
}

// The genuine replacement case must keep reporting true, so a reconnect's
// teardown does not mark the live connection's user offline.
func TestUnregisterNow_ReplacedClientIsReportedAsReplaced(t *testing.T) {
	h := newEmitTestHub()
	old := NewTestClient(h, 1, make(chan []byte, 4))
	live := NewTestClient(h, 1, make(chan []byte, 4))
	h.clients[1] = live // the reconnect already took the slot

	if replaced := h.unregisterNow(old); !replaced {
		t.Error("unregisterNow(old client) = false, want true (a live client holds the slot)")
	}
	if _, ok := h.clients[1]; !ok {
		t.Error("unregisterNow(old client) evicted the live client from the hub")
	}
}
