//go:build !deadlock

package metrics

import (
	"testing"
	"time"
)

// The deadlock-detecting mutex allocates on Lock, so the zero-allocation claim
// is checked in the ordinary build only (the same split as the admin and ws
// allocation tests).
func TestWindows_SampleDoesNotAllocate(t *testing.T) {
	w, h, g, c := newTestWindows(t)
	now := t0
	for range 200 { // wrap the ring first
		now = now.Add(10 * time.Second)
		w.sample(now)
	}
	allocs := testing.AllocsPerRun(100, func() {
		h.Observe(1)
		g.Observe(1)
		c.Add(1)
		now = now.Add(10 * time.Second)
		w.sample(now)
	})
	if allocs != 0 {
		t.Fatalf("sample allocates %v times, want 0", allocs)
	}
}
