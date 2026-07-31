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
