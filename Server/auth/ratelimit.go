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
