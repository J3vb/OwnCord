package auth_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestRateLimiter_UnderLimitAllowed(t *testing.T) {
	rl := auth.NewRateLimiter()
	for i := range 5 {
		if !rl.Allow("key1", 5, time.Second) {
			t.Errorf("Allow() = false at iteration %d, want true", i)
		}
	}
}

func TestRateLimiter_AtLimitAllowed(t *testing.T) {
	rl := auth.NewRateLimiter()
	// Allow up to exactly the limit
	for range 3 {
		rl.Allow("keyA", 3, time.Second)
	}
	// The 4th call should be blocked
	if rl.Allow("keyA", 3, time.Second) {
		t.Error("Allow() = true after limit exceeded, want false")
	}
}

func TestRateLimiter_OverLimitBlocked(t *testing.T) {
	rl := auth.NewRateLimiter()
	limit := 3
	for range limit {
		rl.Allow("key2", limit, time.Second)
	}
	if rl.Allow("key2", limit, time.Second) {
		t.Error("Allow() = true when over limit, want false")
	}
}

func TestRateLimiter_WindowExpiryResets(t *testing.T) {
	rl := auth.NewRateLimiter()
	window := 50 * time.Millisecond
	limit := 2
	// Exhaust limit
	rl.Allow("key3", limit, window)
	rl.Allow("key3", limit, window)
	if rl.Allow("key3", limit, window) {
		t.Error("Allow() should be blocked after exhausting limit")
	}
	// Wait for window to expire
	time.Sleep(window + 10*time.Millisecond)
	if !rl.Allow("key3", limit, window) {
		t.Error("Allow() should be permitted after window expires")
	}
}

func TestRateLimiter_DifferentKeysIndependent(t *testing.T) {
	rl := auth.NewRateLimiter()
	for range 5 {
		rl.Allow("keyX", 3, time.Second)
	}
	// keyY should still be allowed
	if !rl.Allow("keyY", 3, time.Second) {
		t.Error("Allow() blocked keyY even though only keyX exceeded limit")
	}
}

func TestRateLimiter_LockoutEnforced(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "keyLock", time.Hour)
	if !rl.IsLockedOut("keyLock") {
		t.Error("IsLockedOut() = false after Lockout(), want true")
	}
}

func TestRateLimiter_LockoutExpires(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "keyExp", 30*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	if rl.IsLockedOut("keyExp") {
		t.Error("IsLockedOut() = true after lockout expired, want false")
	}
}

func TestRateLimiter_IsLockedOut_UnknownKey(t *testing.T) {
	rl := auth.NewRateLimiter()
	if rl.IsLockedOut("unknown") {
		t.Error("IsLockedOut() = true for unknown key, want false")
	}
}

func TestRateLimiter_Reset(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Allow("keyR", 1, time.Second)
	rl.Allow("keyR", 1, time.Second) // now blocked
	rl.Reset(context.Background(), "keyR")
	if !rl.Allow("keyR", 1, time.Second) {
		t.Error("Allow() = false after Reset(), want true")
	}
}

func TestRateLimiter_LockoutBlocksAllow(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "keyLB", time.Hour)
	// Even under normal limit, lockout should block
	if rl.Allow("keyLB", 100, time.Second) {
		t.Error("Allow() = true for locked-out key, want false")
	}
}

func TestRateLimiter_ThreadSafe(t *testing.T) {
	rl := auth.NewRateLimiter()
	done := make(chan struct{}, 100)
	for range 100 {
		go func() {
			rl.Allow("concurrent", 50, time.Second)
			done <- struct{}{}
		}()
	}
	for range 100 {
		<-done
	}
	// If we get here without a race condition data race, we pass
}

// ─── Check (read-only rate-limit query) ─────────────────────────────────────

func TestRateLimiter_Check_UnderLimit(t *testing.T) {
	rl := auth.NewRateLimiter()
	// No requests recorded yet — Check should return true.
	if !rl.Check("checkKey", 5, time.Second) {
		t.Error("Check() = false for fresh key, want true")
	}
}

func TestRateLimiter_Check_DoesNotRecordTimestamp(t *testing.T) {
	rl := auth.NewRateLimiter()
	// Call Check many times — it must NOT record timestamps.
	for range 10 {
		rl.Check("checkKey2", 3, time.Second)
	}
	// Allow should still succeed because Check didn't record anything.
	if !rl.Allow("checkKey2", 3, time.Second) {
		t.Error("Allow() = false after only Check() calls, want true")
	}
}

func TestRateLimiter_Check_AtLimit(t *testing.T) {
	rl := auth.NewRateLimiter()
	// Record exactly 3 requests via Allow.
	for range 3 {
		rl.Allow("checkKey3", 3, time.Second)
	}
	// Check should report the key is at/over limit.
	if rl.Check("checkKey3", 3, time.Second) {
		t.Error("Check() = true when at limit, want false")
	}
}

func TestRateLimiter_Check_RespectsLockout(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "checkLocked", time.Hour)
	if rl.Check("checkLocked", 100, time.Second) {
		t.Error("Check() = true for locked-out key, want false")
	}
}

func TestRateLimiter_Check_LockoutExpired(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "checkExpLock", 10*time.Millisecond)
	time.Sleep(30 * time.Millisecond)
	if !rl.Check("checkExpLock", 5, time.Second) {
		t.Error("Check() = false after lockout expired, want true")
	}
}

func TestRateLimiter_Check_WindowBoundary(t *testing.T) {
	rl := auth.NewRateLimiter()
	window := 50 * time.Millisecond
	// Exhaust limit.
	for range 3 {
		rl.Allow("checkBound", 3, window)
	}
	if rl.Check("checkBound", 3, window) {
		t.Error("Check() = true at limit, want false")
	}
	// Wait for window to expire.
	time.Sleep(window + 20*time.Millisecond)
	if !rl.Check("checkBound", 3, window) {
		t.Error("Check() = false after window expired, want true")
	}
}

// ─── Concurrent hammering ───────────────────────────────────────────────────

func TestRateLimiter_ConcurrentHammering(t *testing.T) {
	rl := auth.NewRateLimiter()
	limit := 10
	window := time.Second
	allowed := make(chan bool, 200)

	for range 200 {
		go func() {
			allowed <- rl.Allow("hammer", limit, window)
		}()
	}

	trueCount := 0
	for range 200 {
		if <-allowed {
			trueCount++
		}
	}
	// Exactly `limit` requests should be allowed.
	if trueCount != limit {
		t.Errorf("concurrent Allow() allowed %d requests, want exactly %d", trueCount, limit)
	}
}

func TestRateLimiter_ResetClearsLockout(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout(context.Background(), "resetLock", time.Hour)
	if !rl.IsLockedOut("resetLock") {
		t.Fatal("precondition: key should be locked out")
	}
	rl.Reset(context.Background(), "resetLock")
	if rl.IsLockedOut("resetLock") {
		t.Error("Reset() should clear lockout, but key is still locked out")
	}
}

func TestKey_MatchesSprintfShape(t *testing.T) {
	cases := []struct {
		prefix string
		id     int64
		want   string
	}{
		{"ping", 42, "ping:42"},
		{"voice_join", 0, "voice_join:0"},
		{"login", -7, "login:-7"},
		{"session", 9223372036854775807, "session:9223372036854775807"},
	}
	for _, c := range cases {
		if got := auth.Key(c.prefix, c.id); got != c.want {
			t.Errorf("Key(%q, %d) = %q, want %q", c.prefix, c.id, got, c.want)
		}
	}
	// Multi-part keys compose by nesting, matching the old "%d:%d" shape.
	if got := auth.Key(auth.Key("voice_e2ee_offer", 3), 15); got != "voice_e2ee_offer:3:15" {
		t.Errorf("nested Key = %q, want voice_e2ee_offer:3:15", got)
	}
}

// TestRateLimiter_LenSumsAcrossShards pins the sharded rewrite: keys that hash
// to different buckets must all be visible through Len and evictable through
// Cleanup, exactly as with the old single-map limiter.
func TestRateLimiter_LenSumsAcrossShards(t *testing.T) {
	rl := auth.NewRateLimiter()
	const n = 100 // enough distinct keys to populate many of the 32 shards
	for i := range n {
		if !rl.Allow(auth.Key("shardspread", int64(i)), 1, time.Minute) {
			t.Fatalf("Allow for fresh key %d = false, want true", i)
		}
	}
	if wins, _ := rl.Len(); wins != n {
		t.Fatalf("Len().windows = %d, want %d", wins, n)
	}
	time.Sleep(15 * time.Millisecond)
	rl.Cleanup(10 * time.Millisecond)
	if wins, _ := rl.Len(); wins != 0 {
		t.Errorf("Len().windows = %d after Cleanup, want 0 across all shards", wins)
	}
}

// TestRateLimiter_CleanupHorizonShorterThanWindowForgetsHistory is N2's
// (B5-10 review) documentation of the bug a too-short cleanup horizon
// causes, and the regression guard for its fix: three submissions seven
// hours ago (past a 6h horizon, well under a 24h window — e.g. api's old
// rateLimiterCleanupMaxWindow against service/appeal.go's 3-per-24h cap) are
// wiped by a 6h cleanup even though the window they belong to has not
// elapsed, letting a fourth submission through that a real 24h memory would
// still refuse. A cleanup horizon that actually covers the window (24h)
// must not lose them.
func TestRateLimiter_CleanupHorizonShorterThanWindowForgetsHistory(t *testing.T) {
	const key = "appeal:1"
	sevenHoursAgo := time.Now().Add(-7 * time.Hour)

	t.Run("a 6h horizon forgets a 7h-old submission (the bug)", func(t *testing.T) {
		rl := auth.NewRateLimiter()
		for range 3 {
			rl.SeedTimestampForTest(key, sevenHoursAgo)
		}
		rl.Cleanup(6 * time.Hour)
		if wins, _ := rl.Len(); wins != 0 {
			t.Fatalf("Len().windows = %d after a 6h cleanup, want 0 (the entry should have been evicted)", wins)
		}
		// With the history gone, three more submissions are allowed even
		// though the real 24h window should still remember the first three.
		for i := range 3 {
			if !rl.Allow(key, 3, 24*time.Hour) {
				t.Fatalf("Allow() = false at iteration %d after the cleanup wiped history, want true (demonstrating the bug)", i)
			}
		}
	})

	t.Run("a 24h horizon remembers a 7h-old submission (the fix)", func(t *testing.T) {
		rl := auth.NewRateLimiter()
		for range 3 {
			rl.SeedTimestampForTest(key, sevenHoursAgo)
		}
		rl.Cleanup(24 * time.Hour)
		if wins, _ := rl.Len(); wins != 1 {
			t.Fatalf("Len().windows = %d after a 24h cleanup, want 1 (the entry must survive)", wins)
		}
		// The three 7h-old submissions still count against the 24h window,
		// so a fourth is refused.
		if rl.Allow(key, 3, 24*time.Hour) {
			t.Fatal("Allow() = true for a 4th submission within 24h of three others, want false")
		}
	})
}
