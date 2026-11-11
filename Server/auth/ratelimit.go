package auth

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// entry records request timestamps for sliding-window limiting. window is the
// key's own horizon, so Cleanup retires short-window keys promptly while a 24h
// key's history survives; Allow ratchets it up, never down, so a shrunken then
// regrown window (per-channel slow mode) cannot have history evicted early.
type entry struct {
	timestamps []time.Time
	window     time.Duration
}

// lockoutEntry records when a lockout expires.
type lockoutEntry struct {
	expiresAt time.Time
}

// LockoutPersister is an optional backend so lockouts survive restarts; it uses
// only stdlib types to avoid import cycles.
type LockoutPersister interface {
	UpsertLockout(ctx context.Context, key string, expiresAt time.Time) error
	DeleteLockout(ctx context.Context, key string) error
	CleanupExpiredLockouts(ctx context.Context) error
	// LoadActiveLockouts returns (keys, expiresAt) slices of equal length.
	LoadActiveLockouts(ctx context.Context) (keys []string, expiresAt []time.Time, err error)
}

// rateLimiterShards is the number of independently locked buckets the key space
// is split across; a power of two (shardFor masks with -1).
const rateLimiterShards = 32

// rateLimiterShard holds one bucket's maps under its own mutex.
type rateLimiterShard struct {
	// ioMu orders a lockout's memory change and store write against the next on
	// the shard, so Lockout and Reset reach the store in order. Taken before mu,
	// never held by Allow/Check.
	ioMu     syncutil.Mutex
	mu       syncutil.Mutex
	windows  map[string]*entry
	lockouts map[string]*lockoutEntry
}

// RateLimiter is a thread-safe sliding-window rate limiter with optional
// persisted lockouts, sharded by FNV-1a of the key so no single lock funnels
// every request.
//
// The window counters and the PartialAuthStore / UsedTOTPCodeStore (totp.go)
// are process-local, so the server must run as a single instance.
type RateLimiter struct {
	shards [rateLimiterShards]rateLimiterShard
	store  LockoutPersister // nil = pure in-memory (tests, non-login limiters)
	// admission is the one budget for expensive auth work, here because the
	// limiter is the single instance all routes and the hub share.
	admission *AdmissionBudget
}

// newRateLimiter allocates the per-shard maps for both constructors.
func newRateLimiter(store LockoutPersister) *RateLimiter {
	rl := &RateLimiter{store: store, admission: NewAdmissionBudget(0)}
	for i := range rl.shards {
		rl.shards[i].windows = make(map[string]*entry)
		rl.shards[i].lockouts = make(map[string]*lockoutEntry)
	}
	return rl
}

// NewRateLimiter returns an initialised RateLimiter with no persistence.
func NewRateLimiter() *RateLimiter {
	return newRateLimiter(nil)
}

// NewPersistentRateLimiter returns a RateLimiter that persists lockouts via
// store and loads any active lockouts from it on creation.
func NewPersistentRateLimiter(store LockoutPersister) *RateLimiter {
	rl := newRateLimiter(store)
	// Startup, no request in flight, so a background context.
	if keys, expiresAt, err := store.LoadActiveLockouts(context.Background()); err == nil {
		for i, key := range keys {
			rl.shardFor(key).lockouts[key] = &lockoutEntry{expiresAt: expiresAt[i]}
		}
	} else {
		slog.Warn("ratelimit: failed to load persisted lockouts; starting with none", "err", err)
	}
	return rl
}

// Admission is the process-wide budget for expensive authentication work.
func (r *RateLimiter) Admission() *AdmissionBudget { return r.admission }

// SetAdmissionBudget replaces the budget (security.expensive_auth_concurrency;
// zero means the default). Call it at startup, never with requests in flight.
func (r *RateLimiter) SetAdmissionBudget(size int) { r.admission = NewAdmissionBudget(size) }

// shardFor maps key to its bucket via an inlined, allocation-free FNV-1a.
func (r *RateLimiter) shardFor(key string) *rateLimiterShard {
	h := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return &r.shards[h&(rateLimiterShards-1)]
}

// Key builds the canonical "prefix:id" rate-limit key without fmt.Sprintf, which
// the hot paths avoid. Nest for multi-part keys: Key(Key("voice_e2ee_offer", userID), channelID).
func Key(prefix string, id int64) string {
	b := make([]byte, 0, len(prefix)+21) // ':' + up to 20 digits/sign
	b = append(b, prefix...)
	b = append(b, ':')
	b = strconv.AppendInt(b, id, 10)
	return string(b)
}

// Allow reports whether a request from key is permitted, recording the
// timestamp only when it is; false when locked out or over limit within window.
func (r *RateLimiter) Allow(key string, limit int, window time.Duration) bool {
	_, ok := r.record(key, limit, window)
	return ok
}

// Reserve is Allow for an attempt that may not count: refund takes back the
// recorded timestamp, so a caller refused later for a reason that is not the
// key's own leaves the budget untouched. The slot is held from the start, so
// concurrent attempts never exceed limit. refund is idempotent, a no-op when ok is false.
func (r *RateLimiter) Reserve(key string, limit int, window time.Duration) (refund func(), ok bool) {
	stamp, ok := r.record(key, limit, window)
	if !ok {
		return func() {}, false
	}
	var once sync.Once
	return func() { once.Do(func() { r.unrecord(key, stamp) }) }, true
}

// unrecord removes one timestamp equal to stamp from key's window.
func (r *RateLimiter) unrecord(key string, stamp time.Time) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.windows[key]
	if !ok {
		return
	}
	for i, ts := range e.timestamps {
		if ts.Equal(stamp) {
			e.timestamps = append(e.timestamps[:i], e.timestamps[i+1:]...)
			return
		}
	}
}

// record is Allow returning the timestamp it recorded.
func (r *RateLimiter) record(key string, limit int, window time.Duration) (stamp time.Time, ok bool) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()

	// Lockout takes priority.
	if lo, found := s.lockouts[key]; found {
		if time.Now().Before(lo.expiresAt) {
			return time.Time{}, false
		}
		delete(s.lockouts, key)
	}

	now := time.Now()
	cutoff := now.Add(-window)

	e, found := s.windows[key]
	if !found {
		e = &entry{}
		s.windows[key] = e
	}
	// Ratchet Cleanup's horizon to the largest window seen (see entry): a smaller
	// later window must not discard a timestamp a restored longer one still needs.
	if window > e.window {
		e.window = window
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
		return time.Time{}, false
	}

	e.timestamps = append(e.timestamps, now)
	return now, true
}

// RetryAfter returns the time until key may retry, i.e. until its oldest
// request leaves the window; 0 when not over its limit.
func (r *RateLimiter) RetryAfter(key string, limit int, window time.Duration) time.Duration {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if lo, ok := s.lockouts[key]; ok && now.Before(lo.expiresAt) {
		return time.Until(lo.expiresAt)
	}
	e, ok := s.windows[key]
	if !ok {
		return 0
	}
	cutoff := now.Add(-window)
	valid := e.timestamps[:0]
	for _, ts := range e.timestamps {
		if ts.After(cutoff) {
			valid = append(valid, ts)
		}
	}
	e.timestamps = valid
	if len(valid) < limit {
		return 0
	}
	return valid[0].Add(window).Sub(now)
}

// Lockout blocks key for duration regardless of the window counter, persisting
// it when a store is configured. The write must land once decided, so the
// caller's cancellation is detached.
func (r *RateLimiter) Lockout(ctx context.Context, key string, duration time.Duration) {
	s := r.shardFor(key)
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	expiresAt := time.Now().Add(duration)
	s.mu.Lock()
	s.lockouts[key] = &lockoutEntry{expiresAt: expiresAt}
	s.mu.Unlock()
	if r.store != nil {
		if err := r.store.UpsertLockout(context.WithoutCancel(ctx), key, expiresAt); err != nil {
			slog.Warn("ratelimit: failed to persist lockout; it will not survive a restart",
				"key", key, "err", err)
		}
	}
}

// IsLockedOut reports whether key is currently under a lockout.
func (r *RateLimiter) IsLockedOut(key string) bool {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	lo, ok := s.lockouts[key]
	if !ok {
		return false
	}
	if time.Now().Before(lo.expiresAt) {
		return true
	}
	delete(s.lockouts, key)
	return false
}

// Check reports whether a request from key would be permitted without recording
// a timestamp, for callers that record (via Allow) only on failures.
func (r *RateLimiter) Check(key string, limit int, window time.Duration) bool {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()

	if lo, ok := s.lockouts[key]; ok {
		if time.Now().Before(lo.expiresAt) {
			return false
		}
		delete(s.lockouts, key)
	}

	cutoff := time.Now().Add(-window)

	e, ok := s.windows[key]
	if !ok {
		return true
	}

	count := 0
	for _, ts := range e.timestamps {
		if ts.After(cutoff) {
			count++
		}
	}

	return count < limit
}

// Reset clears all rate-limit state for key. Like Lockout, the store delete is
// detached from cancellation; the store is touched only when an in-memory
// lockout existed, and never while the shard lock is held.
func (r *RateLimiter) Reset(ctx context.Context, key string) {
	s := r.shardFor(key)
	s.ioMu.Lock()
	defer s.ioMu.Unlock()
	s.mu.Lock()
	delete(s.windows, key)
	_, hadLockout := s.lockouts[key]
	delete(s.lockouts, key)
	s.mu.Unlock()
	if hadLockout && r.store != nil {
		if err := r.store.DeleteLockout(context.WithoutCancel(ctx), key); err != nil {
			slog.Warn("ratelimit: failed to delete persisted lockout; it may reappear after a restart",
				"key", key, "err", err)
		}
	}
}

// Cleanup evicts stale entries: a window once every timestamp is older than its
// own window, a lockout once expired. Shards are swept one at a time so it never
// stalls the whole limiter.
func (r *RateLimiter) Cleanup() {
	r.CleanupContext(context.Background())
}

// CleanupContext is Cleanup with ctx bounding the persisted-lockout sweep.
func (r *RateLimiter) CleanupContext(ctx context.Context) {
	now := time.Now()

	for i := range r.shards {
		s := &r.shards[i]
		s.mu.Lock()

		for key, e := range s.windows {
			cutoff := now.Add(-e.window)
			allStale := true
			for _, ts := range e.timestamps {
				if ts.After(cutoff) {
					allStale = false
					break
				}
			}
			if allStale {
				delete(s.windows, key)
			}
		}

		for key, lo := range s.lockouts {
			if now.After(lo.expiresAt) {
				delete(s.lockouts, key)
			}
		}

		s.mu.Unlock()
	}

	if r.store != nil {
		if err := r.store.CleanupExpiredLockouts(ctx); err != nil {
			slog.Warn("ratelimit: failed to clean up expired persisted lockouts", "err", err)
		}
	}
}

// RunCleanup runs Cleanup every interval until ctx is done.
func (r *RateLimiter) RunCleanup(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			r.CleanupContext(ctx)
		case <-ctx.Done():
			return
		}
	}
}

// Len returns the windows and lockouts entry counts, summed across shards.
func (r *RateLimiter) Len() (windows, lockouts int) {
	for i := range r.shards {
		s := &r.shards[i]
		s.mu.Lock()
		windows += len(s.windows)
		lockouts += len(s.lockouts)
		s.mu.Unlock()
	}
	return windows, lockouts
}
