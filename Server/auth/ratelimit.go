package auth

import (
	"sync"
	"time"
)

// entry records individual request timestamps for sliding-window limiting.
type entry struct {
	timestamps []time.Time
}

// lockoutEntry records when a lockout expires.
type lockoutEntry struct {
	expiresAt time.Time
}

// RateLimiter is an in-memory, thread-safe sliding-window rate limiter with
// optional IP lockout support.
type RateLimiter struct {
	mu       sync.Mutex
	windows  map[string]*entry
	lockouts map[string]*lockoutEntry
}

// NewRateLimiter returns an initialised RateLimiter.
func NewRateLimiter() *RateLimiter {
	return &RateLimiter{
		windows:  make(map[string]*entry),
		lockouts: make(map[string]*lockoutEntry),
	}
}

// Allow reports whether a request from key is permitted given the limit and
// window. It records the current request timestamp regardless of the outcome.
// Returns false when key is locked out or has exceeded limit within window.
func (r *RateLimiter) Allow(key string, limit int, window time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Lockout takes priority.
	if lo, ok := r.lockouts[key]; ok {
		if time.Now().Before(lo.expiresAt) {
			return false
		}
		delete(r.lockouts, key)
	}

	now := time.Now()
	cutoff := now.Add(-window)

	e, ok := r.windows[key]
	if !ok {
		e = &entry{}
		r.windows[key] = e
	}

	// Prune timestamps outside the current window.
	valid := e.timestamps[:0]
	for _, ts := range e.timestamps {
		if ts.After(cutoff) {
			valid = append(valid, ts)
		}
	}
	e.timestamps = valid

	if len(e.timestamps) >= limit {
		return false
	}

	e.timestamps = append(e.timestamps, now)
	return true
}

// Lockout prevents any requests from key for duration regardless of the
// sliding-window counter.
func (r *RateLimiter) Lockout(key string, duration time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lockouts[key] = &lockoutEntry{expiresAt: time.Now().Add(duration)}
}

// IsLockedOut reports whether key is currently under a lockout.
func (r *RateLimiter) IsLockedOut(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	lo, ok := r.lockouts[key]
	if !ok {
		return false
	}
	if time.Now().Before(lo.expiresAt) {
		return true
	}
	delete(r.lockouts, key)
	return false
}

// Reset clears all rate-limit state (timestamps and lockout) for key.
func (r *RateLimiter) Reset(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.windows, key)
	delete(r.lockouts, key)
}

// Cleanup evicts stale map entries to prevent unbounded memory growth.
//
// A windows entry is removed when every recorded timestamp is older than
// maxWindow — meaning the entry could not affect any future Allow call that
// uses a window equal to or shorter than maxWindow.
//
// A lockouts entry is removed when its expiry has passed.
//
// Pass defaultCleanupMaxWindow (15 minutes) for normal server operation, or
// a shorter duration in tests.
func (r *RateLimiter) Cleanup(maxWindow time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()

	cutoff := time.Now().Add(-maxWindow)

	for key, e := range r.windows {
		allStale := true
		for _, ts := range e.timestamps {
			if ts.After(cutoff) {
				allStale = false
				break
			}
		}
		if allStale {
			delete(r.windows, key)
		}
	}

	now := time.Now()
	for key, lo := range r.lockouts {
		if now.After(lo.expiresAt) {
			delete(r.lockouts, key)
		}
	}
}

// StartCleanup runs Cleanup on a ticker with the given interval until the
// stop channel is closed. It is intended to be called in a goroutine:
//
//	stop := make(chan struct{})
//	go rl.StartCleanup(5*time.Minute, 15*time.Minute, stop)
//
// Closing stop causes the goroutine to exit promptly.
func (r *RateLimiter) StartCleanup(interval, maxWindow time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			r.Cleanup(maxWindow)
		case <-stop:
			return
		}
	}
}

// Len returns the number of entries currently stored in the windows and
// lockouts maps. It is primarily useful for testing and monitoring.
func (r *RateLimiter) Len() (windows, lockouts int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.windows), len(r.lockouts)
}
