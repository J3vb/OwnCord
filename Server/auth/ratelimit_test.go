package auth_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
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
	// A short window (item 6, round 3 review): Cleanup retires each entry on
	// its OWN window now, not a caller-supplied horizon, so this test's own
	// staleness has to come from the window Allow recorded.
	for i := range n {
		if !rl.Allow(auth.Key("shardspread", int64(i)), 1, 10*time.Millisecond) {
			t.Fatalf("Allow for fresh key %d = false, want true", i)
		}
	}
	if wins, _ := rl.Len(); wins != n {
		t.Fatalf("Len().windows = %d, want %d", wins, n)
	}
	time.Sleep(15 * time.Millisecond)
	rl.Cleanup()
	if wins, _ := rl.Len(); wins != 0 {
		t.Errorf("Len().windows = %d after Cleanup, want 0 across all shards", wins)
	}
}

// TestRateLimiter_CleanupHorizonShorterThanWindowForgetsHistory is N2's
// (B5-10 review) bug and item 6's (round 3 review) fix: Cleanup used to take
// ONE server-wide horizon for every key, forcing a choice between reclaiming
// a short-window key promptly and covering service.AppealRateWindow's 24h
// cap — too short (e.g. 6h) wiped a 7h-old appeal submission before its real
// 24h window elapsed, letting a submission through that should have been
// refused. Recording each key's own window (auth/ratelimit.go's
// entry.window) removes that trade-off entirely: ONE Cleanup() sweep, no
// argument, retires a short-window key within its own few minutes while the
// appeal key survives until it is genuinely 24h stale. AppealRateWindow is
// the real exported production constant (not a local literal), so this test
// cannot stay green if production's window ever regresses out of sync with
// what Cleanup is asked to preserve.
func TestRateLimiter_CleanupHorizonShorterThanWindowForgetsHistory(t *testing.T) {
	const shortKey = "login:1"   // e.g. a 1-minute login-attempt window
	const appealKey = "appeal:1" // service.AppealRateWindow (24h)
	sevenHoursAgo := time.Now().Add(-7 * time.Hour)

	rl := auth.NewRateLimiter()
	for range 3 {
		rl.SeedTimestampForTest(shortKey, sevenHoursAgo, time.Minute)
		rl.SeedTimestampForTest(appealKey, sevenHoursAgo, service.AppealRateWindow)
	}
	if wins, _ := rl.Len(); wins != 2 {
		t.Fatalf("Len().windows = %d before Cleanup, want 2 (one entry per key)", wins)
	}

	rl.Cleanup()

	// The short-window key is 7h past its own 1-minute window: its whole
	// entry is reclaimed, not merely pruned down to zero timestamps.
	if wins, _ := rl.Len(); wins != 1 {
		t.Fatalf("Len().windows = %d after Cleanup, want 1 (only the appeal key survives)", wins)
	}
	// The appeal key is 7h old, well under its real 24h window: survives,
	// so the three seeded submissions still count and a fourth is refused.
	if rl.Allow(appealKey, 3, service.AppealRateWindow) {
		t.Fatal("Allow(appealKey) after Cleanup = true, want false — a 7h-old submission is still within the real 24h window and must not have been forgotten")
	}
}
