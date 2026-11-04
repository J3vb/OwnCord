package api

import (
	"fmt"
	"testing"
	"time"
)

// Stale entries go once per interval however many sessions are live, and a
// session inside its interval is never touched twice.
func TestTouchThrottle_SweepsByAgeOncePerInterval(t *testing.T) {
	tt := &touchThrottle{seen: make(map[string]time.Time)}
	start := time.Unix(1_700_000_000, 0)
	const live = 100
	for i := range live {
		if !tt.shouldTouch(fmt.Sprintf("s%d", i), start) {
			t.Fatalf("first request of session %d was not touched", i)
		}
	}
	if tt.shouldTouch("s0", start.Add(sessionTouchInterval/2)) {
		t.Fatal("a session was touched twice inside one interval")
	}
	if len(tt.seen) != live {
		t.Fatalf("map holds %d entries inside the interval, want %d", len(tt.seen), live)
	}

	later := start.Add(sessionTouchInterval + time.Second)
	if !tt.shouldTouch("fresh", later) {
		t.Fatal("a new session was not touched")
	}
	if len(tt.seen) != 1 {
		t.Fatalf("map holds %d entries after the sweep, want only the fresh session", len(tt.seen))
	}
	if !tt.shouldTouch("s1", later) {
		t.Fatal("a swept session was not touched on its next request")
	}
}
