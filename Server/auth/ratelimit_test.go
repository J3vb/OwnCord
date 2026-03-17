package auth_test

import (
	"testing"
	"time"

	"github.com/owncord/server/auth"
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
	rl.Lockout("keyLock", time.Hour)
	if !rl.IsLockedOut("keyLock") {
		t.Error("IsLockedOut() = false after Lockout(), want true")
	}
}

func TestRateLimiter_LockoutExpires(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout("keyExp", 30*time.Millisecond)
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
	rl.Reset("keyR")
	if !rl.Allow("keyR", 1, time.Second) {
		t.Error("Allow() = false after Reset(), want true")
	}
}

func TestRateLimiter_LockoutBlocksAllow(t *testing.T) {
	rl := auth.NewRateLimiter()
	rl.Lockout("keyLB", time.Hour)
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
