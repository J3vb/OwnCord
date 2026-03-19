package auth_test

import (
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

// ─── Cleanup ──────────────────────────────────────────────────────────────────

// TestCleanup_RemovesExpiredWindows verifies that window entries whose
// timestamps are all older than the max window are deleted by Cleanup.
func TestCleanup_RemovesExpiredWindows(t *testing.T) {
	rl := auth.NewRateLimiter()

	// Populate a window entry that will have expired timestamps.
	shortWindow := 30 * time.Millisecond
	rl.Allow("stale-ip", 10, shortWindow)

	// Wait long enough that all timestamps fall outside the 15-minute
	// cleanup horizon — we override by using a very short max-window for test.
	time.Sleep(shortWindow + 10*time.Millisecond)

	// Use a maxWindow shorter than 15 minutes so the test runs fast.
	rl.Cleanup(shortWindow)

	wins, _ := rl.Len()
	if wins != 0 {
		t.Errorf("Len().windows = %d after Cleanup, want 0 (stale entry should be evicted)", wins)
	}
}

// TestCleanup_RemovesExpiredLockouts verifies that expired lockout entries
// are deleted by Cleanup.
func TestCleanup_RemovesExpiredLockouts(t *testing.T) {
	rl := auth.NewRateLimiter()

	rl.Lockout("stale-lockout", 20*time.Millisecond)
	time.Sleep(40 * time.Millisecond)

	rl.Cleanup(15 * time.Minute)

	_, locks := rl.Len()
	if locks != 0 {
		t.Errorf("Len().lockouts = %d after Cleanup, want 0 (expired lockout should be evicted)", locks)
	}
}

// TestCleanup_PreservesActiveWindows verifies that a window with recent
// timestamps is NOT evicted during Cleanup.
func TestCleanup_PreservesActiveWindows(t *testing.T) {
	rl := auth.NewRateLimiter()

	// Issue a request; the timestamp is recent.
	rl.Allow("active-ip", 100, time.Hour)

	// Cleanup with a 15-minute max window should keep the fresh entry.
	rl.Cleanup(15 * time.Minute)

	wins, _ := rl.Len()
	if wins != 1 {
		t.Errorf("Len().windows = %d after Cleanup, want 1 (active entry should be preserved)", wins)
	}
}

// TestCleanup_PreservesActiveLockouts verifies that a non-expired lockout
// is NOT deleted by Cleanup.
func TestCleanup_PreservesActiveLockouts(t *testing.T) {
	rl := auth.NewRateLimiter()

	rl.Lockout("live-lockout", time.Hour)

	rl.Cleanup(15 * time.Minute)

	_, locks := rl.Len()
	if locks != 1 {
		t.Errorf("Len().lockouts = %d after Cleanup, want 1 (active lockout should be preserved)", locks)
	}
}

// TestCleanup_MixedEntries verifies that Cleanup correctly partitions stale
// from active entries when both are present.
//
// Strategy: the "stale" window key gets a single request right now, then we
// sleep until that timestamp is outside the cleanup maxWindow.  The "active"
// key gets a new request AFTER the sleep so its timestamp is always fresh.
func TestCleanup_MixedEntries(t *testing.T) {
	rl := auth.NewRateLimiter()
	shortWindow := 30 * time.Millisecond

	// Stale window entry — its timestamp will be older than shortWindow.
	rl.Allow("stale", 10, shortWindow)
	// Stale lockout — expires in shortWindow.
	rl.Lockout("stale-lock", shortWindow)

	// Wait until the stale timestamps fall outside shortWindow.
	time.Sleep(shortWindow + 10*time.Millisecond)

	// Active entries added AFTER the sleep — their timestamps are fresh.
	rl.Allow("active", 10, time.Hour)
	rl.Lockout("live-lock", time.Hour)

	// Cleanup with shortWindow: "stale" was recorded before the cutoff, so it
	// is evicted.  "active" was just recorded, so it is kept.
	rl.Cleanup(shortWindow)

	wins, locks := rl.Len()
	if wins != 1 {
		t.Errorf("windows = %d, want 1 (only active should remain)", wins)
	}
	if locks != 1 {
		t.Errorf("lockouts = %d, want 1 (only live lockout should remain)", locks)
	}
}

// ─── Len ─────────────────────────────────────────────────────────────────────

// TestLen_Empty verifies Len returns (0, 0) on a fresh RateLimiter.
func TestLen_Empty(t *testing.T) {
	rl := auth.NewRateLimiter()
	wins, locks := rl.Len()
	if wins != 0 || locks != 0 {
		t.Errorf("Len() = (%d, %d), want (0, 0) on empty RateLimiter", wins, locks)
	}
}

// TestLen_AfterAllows verifies Len accurately reflects the number of
// distinct keys that have issued at least one request.
func TestLen_AfterAllows(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Allow("a", 10, time.Hour)
	rl.Allow("b", 10, time.Hour)
	rl.Allow("a", 10, time.Hour) // same key again — should not increment

	wins, _ := rl.Len()
	if wins != 2 {
		t.Errorf("Len().windows = %d, want 2", wins)
	}
}

// TestLen_AfterLockouts verifies Len accurately reflects the number of
// active lockout entries.
func TestLen_AfterLockouts(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout("x", time.Hour)
	rl.Lockout("y", time.Hour)

	_, locks := rl.Len()
	if locks != 2 {
		t.Errorf("Len().lockouts = %d, want 2", locks)
	}
}

// ─── StartCleanup ─────────────────────────────────────────────────────────────

// TestStartCleanup_RunsPeriodically verifies that StartCleanup evicts stale
// entries automatically without a manual Cleanup call.
func TestStartCleanup_RunsPeriodically(t *testing.T) {
	rl := auth.NewRateLimiter()
	shortWindow := 20 * time.Millisecond

	rl.Allow("stale", 10, shortWindow)

	wins, _ := rl.Len()
	if wins != 1 {
		t.Fatalf("expected 1 window entry before cleanup, got %d", wins)
	}

	stop := make(chan struct{})
	// Run cleanup every 10 ms with a 20 ms max window so the stale entry is
	// evicted after the first tick.
	go rl.StartCleanup(10*time.Millisecond, shortWindow, stop)
	defer close(stop)

	// Give the ticker at least two cycles to fire.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		time.Sleep(15 * time.Millisecond)
		if w, _ := rl.Len(); w == 0 {
			return // evicted as expected
		}
	}

	wins, _ = rl.Len()
	if wins != 0 {
		t.Errorf("StartCleanup did not evict stale entry within 200 ms; Len().windows = %d", wins)
	}
}

// TestStartCleanup_StopsOnSignal verifies that closing the stop channel
// terminates the background goroutine (no leak).  We cannot observe the
// goroutine directly, but we verify no panic/deadlock occurs after stop.
func TestStartCleanup_StopsOnSignal(t *testing.T) {
	rl := auth.NewRateLimiter()
	stop := make(chan struct{})

	done := make(chan struct{})
	go func() {
		rl.StartCleanup(10*time.Millisecond, 15*time.Minute, stop)
		close(done)
	}()

	close(stop)

	select {
	case <-done:
		// goroutine exited cleanly
	case <-time.After(500 * time.Millisecond):
		t.Error("StartCleanup goroutine did not exit after stop channel was closed")
	}
}
