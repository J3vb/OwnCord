package auth

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// entry records individual request timestamps for sliding-window limiting.
// window is the caller's own window for this key, so one Cleanup sweep retires
// a short-window key (a 1-minute login-attempt key) promptly while a 24h key's
// history (service/appeal.go's per-user cap) survives until it is 24h stale; a
// single server-wide horizon could not do both. Allow ratchets window up to the
// largest ever seen for the key, never down, so a key whose configured window
// shrinks and later grows again (message_crud.go's per-channel slow mode) cannot
// have its history evicted under a superseded smaller horizon.
type entry struct {
	timestamps []time.Time
	window     time.Duration
}

// lockoutEntry records when a lockout expires.
type lockoutEntry struct {
	expiresAt time.Time
}

// LockoutPersister is an optional persistence backend for lockout entries, so
// lockouts survive restarts. It uses only stdlib types to avoid circular
// dependencies between packages.
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

// rateLimiterShard holds one bucket's windows/lockouts maps under its own mutex,
// so contention on one key never serializes unrelated keys.
type rateLimiterShard struct {
	// ioMu orders a lockout's in-memory change and its store write against the
	// next one on the same shard, so Lockout and Reset reach the store in the
	// order they changed memory. Taken before mu, never held by Allow/Check.
	ioMu     syncutil.Mutex
	mu       syncutil.Mutex
	windows  map[string]*entry
	lockouts map[string]*lockoutEntry
}

// RateLimiter is an in-memory, thread-safe sliding-window rate limiter with
// optional IP lockout support; when a lockout store is provided, lockouts are
// persisted so they survive restarts. The key space is sharded across 32
// buckets (FNV-1a of the key), each with its own mutex, so no single lock
// funnels every WS message and HTTP request.
//
// The sliding-window counters and the PartialAuthStore / UsedTOTPCodeStore (in
// totp.go) are process-local, so the server must run as a single instance;
// horizontal scaling needs a shared backend (e.g. Redis).
type RateLimiter struct {
	shards [rateLimiterShards]rateLimiterShard
	store  LockoutPersister // nil = pure in-memory (tests, non-login limiters)
	// admission is the one budget for expensive authentication work; it lives
	// here because the limiter is the single instance the auth routes, profile
	// routes and hub share.
	admission *AdmissionBudget
}

// newRateLimiter allocates the per-shard maps shared by both constructors.
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
	// Load surviving lockouts; the constructor runs at startup with no request
	// in flight, so a background context.
	if keys, expiresAt, err := store.LoadActiveLockouts(context.Background()); err == nil {
		for i, key := range keys {
			rl.shardFor(key).lockouts[key] = &lockoutEntry{expiresAt: expiresAt[i]}
		}
	} else {
		slog.Warn("ratelimit: failed to load persisted lockouts; starting with none", "err", err)
	}
	return rl
}

// Admission is the process-wide budget for expensive authentication work (every
// password compare or hash on an auth route, and the recovery-code match at
// verify), so the one admission decision lives with the one shared limiter.
func (r *RateLimiter) Admission() *AdmissionBudget { return r.admission }

// SetAdmissionBudget replaces the budget with one of size concurrent
// computations (security.expensive_auth_concurrency; zero means the default).
// Startup wiring calls it before any route mounts, never with requests in flight.
func (r *RateLimiter) SetAdmissionBudget(size int) { r.admission = NewAdmissionBudget(size) }

// shardFor maps key to its bucket via FNV-1a, inlined so hashing allocates
// nothing (unlike hash/fnv's digest).
func (r *RateLimiter) shardFor(key string) *rateLimiterShard {
	h := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return &r.shards[h&(rateLimiterShards-1)]
}

// Key builds the canonical "prefix:id" rate-limit key. The hot paths (every WS
// message and authenticated request) avoid fmt.Sprintf: strconv.AppendInt into
// a pre-sized buffer leaves the string as the only allocation. Compose
// multi-part keys by nesting: Key(Key("voice_e2ee_offer", userID), channelID).
func Key(prefix string, id int64) string {
	b := make([]byte, 0, len(prefix)+21) // ':' + up to 20 digits/sign
	b = append(b, prefix...)
	b = append(b, ':')
	b = strconv.AppendInt(b, id, 10)
	return string(b)
}

// Allow reports whether a request from key is permitted given the limit and
// window, recording the current timestamp only when it is. It returns false
// when key is locked out or has exceeded limit within window.
func (r *RateLimiter) Allow(key string, limit int, window time.Duration) bool {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()

	// Lockout takes priority.
	if lo, ok := s.lockouts[key]; ok {
		if time.Now().Before(lo.expiresAt) {
			return false
		}
		delete(s.lockouts, key)
	}

	now := time.Now()
	cutoff := now.Add(-window)

	e, ok := s.windows[key]
	if !ok {
		e = &entry{}
		s.windows[key] = e
	}
	// Cleanup's per-key horizon (see entry), ratcheted to the largest window
	// ever observed for this key rather than overwritten by the last call. A
	// channel's slow-mode window (message_crud.go) is admin-configurable, so the
	// same key can be checked under a short window and later a much longer one;
	// overwriting would let a smaller window downgrade the horizon Cleanup uses
	// to decide the whole entry is stale, discarding a timestamp a restored
	// longer window still needs. Only growing costs a few entries a slightly
	// longer stay in memory and never discards enforcement history early.
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
		return false
	}

	e.timestamps = append(e.timestamps, now)
	return true
}

// RetryAfter returns the whole seconds until key may retry under window, i.e.
// until its oldest recorded request leaves the sliding window; 0 when the key is
// not over its limit. It answers with the true remainder, not the full window.
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

// Lockout prevents any requests from key for duration regardless of the
// sliding-window counter, persisting it when a store is configured. The persist
// write must land once the lockout is decided, so the caller's cancellation is
// detached (WithoutCancel).
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

// Check reports whether a request from key would be permitted given the limit
// and window, without recording a timestamp. Use it for read-only checks where
// the caller records (via Allow) only on specific outcomes such as
// verification failures.
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

// Reset clears all rate-limit state (timestamps and lockout) for key. Like
// Lockout, the store delete must complete once decided (WithoutCancel); the
// store is touched only when an in-memory lockout existed, and never while the
// shard lock is held.
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

// Cleanup evicts stale map entries to prevent unbounded memory growth. A
// windows entry is removed when every timestamp is older than its own window,
// so it can no longer affect Allow for that key; a key with no window recorded
// (only via SeedTimestampForTest with no window, never in production) counts as
// stale. A lockouts entry is removed when its expiry has passed. Shards are
// swept one at a time so cleanup never stalls the whole limiter.
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

// RunCleanup blocks, running Cleanup every interval, and returns when ctx is
// done. The app owns the context.
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

// Len returns the number of entries in the windows and lockouts maps, summed
// across shards, for tests and monitoring.
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
