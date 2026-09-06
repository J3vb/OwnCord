package auth

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// entry records individual request timestamps for sliding-window limiting.
// window is the caller's OWN window for this key (item 6, B5-10 round 3
// review): Cleanup used to take one server-wide horizon for every key,
// which forced an impossible choice — short enough to reclaim a 1-minute
// login-attempt key promptly, or long enough to cover service/appeal.go's
// 24h-per-user cap, never both. Recording each key's own window (set by
// every Allow call, which already knows it) lets one sweep retire a
// short-window key within its own few minutes while a 24h key's history
// survives until it is genuinely 24h stale, with no shared constant to keep
// in sync with the longest caller. window only ever grows for a given key
// (round 4 review, P3) — Allow ratchets it up to the largest window it has
// ever seen for that key, never down, so a key whose configured window
// shrinks and later grows again (message_crud.go's per-channel slow mode)
// cannot have its history evicted by Cleanup using a since-superseded
// smaller horizon.
type entry struct {
	timestamps []time.Time
	window     time.Duration
}

// lockoutEntry records when a lockout expires.
type lockoutEntry struct {
	expiresAt time.Time
}

// LockoutPersister is an optional persistence backend for lockout entries.
// When provided, lockouts survive server restarts. The interface uses only
// stdlib types to avoid circular dependencies between packages.
type LockoutPersister interface {
	UpsertLockout(ctx context.Context, key string, expiresAt time.Time) error
	DeleteLockout(ctx context.Context, key string) error
	CleanupExpiredLockouts(ctx context.Context) error
	// LoadActiveLockouts returns (keys, expiresAt) slices of equal length.
	LoadActiveLockouts(ctx context.Context) (keys []string, expiresAt []time.Time, err error)
}

// rateLimiterShards is the number of independently locked buckets the key
// space is split across. Must be a power of two (shardFor masks with -1).
const rateLimiterShards = 32

// rateLimiterShard holds one bucket's windows/lockouts maps under its own
// mutex, so contention on one key never serializes unrelated keys.
type rateLimiterShard struct {
	mu       syncutil.Mutex
	windows  map[string]*entry
	lockouts map[string]*lockoutEntry
}

// RateLimiter is an in-memory, thread-safe sliding-window rate limiter with
// optional IP lockout support. When a LockoutStore is provided, lockout
// entries are persisted so they survive server restarts.
//
// Internally the key space is sharded across 32 buckets (FNV-1a of the key),
// each with its own mutex, so the process-wide limiter is no longer a single
// lock every WS message and HTTP request funnels through.
//
// NOTE (L2): The sliding-window counters and the PartialAuthStore /
// UsedTOTPCodeStore (in totp.go) are process-local. The server must run
// as a single instance. Horizontal scaling requires migrating these
// stores to a shared backend (e.g. Redis).
type RateLimiter struct {
	shards [rateLimiterShards]rateLimiterShard
	store  LockoutPersister // nil = pure in-memory (tests, non-login limiters)
	// admission is the one budget for expensive authentication work (B4-4).
	// It lives here because the limiter is already the single instance the
	// auth routes, the profile routes and the hub share.
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
// the provided store. It loads any active lockouts from the store on creation.
func NewPersistentRateLimiter(store LockoutPersister) *RateLimiter {
	rl := newRateLimiter(store)
	// Load surviving lockouts from the store. Constructor runs at startup
	// with no request in flight, so background context.
	if keys, expiresAt, err := store.LoadActiveLockouts(context.Background()); err == nil {
		for i, key := range keys {
			rl.shardFor(key).lockouts[key] = &lockoutEntry{expiresAt: expiresAt[i]}
		}
	} else {
		slog.Warn("ratelimit: failed to load persisted lockouts; starting with none", "err", err)
	}
	return rl
}

// Admission is the process-wide budget for expensive authentication work
// (B4-4, SEC-01): every password compare or hash on an auth route, and the
// recovery-code match at verify, is admitted through it, so the single
// server-owned admission decision lives with the single shared limiter.
func (r *RateLimiter) Admission() *AdmissionBudget { return r.admission }

// SetAdmissionBudget replaces the budget with one of size concurrent
// computations (security.expensive_auth_concurrency; zero means the
// default). Startup wiring calls it before any route mounts; it is not for
// use with requests in flight.
func (r *RateLimiter) SetAdmissionBudget(size int) { r.admission = NewAdmissionBudget(size) }

// shardFor maps key to its bucket via FNV-1a (inlined so hashing allocates
// nothing, unlike hash/fnv's digest).
func (r *RateLimiter) shardFor(key string) *rateLimiterShard {
	h := uint32(2166136261)
	for i := 0; i < len(key); i++ {
		h ^= uint32(key[i])
		h *= 16777619
	}
	return &r.shards[h&(rateLimiterShards-1)]
}

// Key builds the canonical "prefix:id" rate-limit key. It exists because the
// hot paths (every WS message, every authenticated request) used to pay for a
// fmt.Sprintf per call; strconv.AppendInt into a pre-sized buffer leaves the
// string itself as the only allocation. Compose multi-part keys by nesting:
// Key(Key("voice_e2ee_offer", userID), channelID).
func Key(prefix string, id int64) string {
	b := make([]byte, 0, len(prefix)+21) // ':' + up to 20 digits/sign
	b = append(b, prefix...)
	b = append(b, ':')
	b = strconv.AppendInt(b, id, 10)
	return string(b)
}

// Allow reports whether a request from key is permitted given the limit and
// window. It records the current request timestamp only when the request is
// permitted. Returns false when key is locked out or has exceeded limit within
// window.
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
	// Cleanup's own per-key horizon (see entry's doc comment), ratcheted to
	// the LARGEST window ever observed for this key rather than overwritten
	// by whichever call happens to run last (round 4 review, P3: a
	// channel's slow-mode window, message_crud.go, is admin-configurable —
	// the same key can be checked under a short window at one point and a
	// much longer one later). Overwriting unconditionally let a transient
	// call with a smaller window than one already recorded downgrade the
	// horizon Cleanup uses to decide the WHOLE entry is stale, discarding a
	// timestamp a since-restored longer window still needed to enforce
	// against — a key rate-limited under a loosened-then-retightened
	// window could lose its history to a Cleanup sweep landing in that
	// gap. Only ever growing costs a few keys' entries a slightly longer
	// stay in memory (until stale under the largest window they were ever
	// checked against); it never discards enforcement history early.
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

// Lockout prevents any requests from key for duration regardless of the
// sliding-window counter. When a LockoutStore is configured, the lockout
// is persisted so it survives server restarts. The persist write must land
// once the lockout is decided, so the caller's cancellation is detached
// (WithoutCancel) rather than aborting the write mid-request.
func (r *RateLimiter) Lockout(ctx context.Context, key string, duration time.Duration) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	expiresAt := time.Now().Add(duration)
	s.lockouts[key] = &lockoutEntry{expiresAt: expiresAt}
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
// and window, WITHOUT recording a new timestamp. Use this for read-only
// rate-limit checks where the caller wants to record (via Allow) only on
// specific outcomes such as verification failures.
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

// Reset clears all rate-limit state (timestamps and lockout) for key.
// Like Lockout, the store delete must complete once decided (WithoutCancel).
func (r *RateLimiter) Reset(ctx context.Context, key string) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.windows, key)
	delete(s.lockouts, key)
	if r.store != nil {
		if err := r.store.DeleteLockout(context.WithoutCancel(ctx), key); err != nil {
			slog.Warn("ratelimit: failed to delete persisted lockout; it may reappear after a restart",
				"key", key, "err", err)
		}
	}
}

// Cleanup evicts stale map entries to prevent unbounded memory growth.
//
// A windows entry is removed when every recorded timestamp is older than
// the entry's OWN window (item 6 review) — meaning the entry could not
// affect any future Allow call for that key, whatever its window is. A
// key with no window recorded yet (only reachable via SeedTimestampForTest
// with no window argument, never in production) is treated as already
// stale, so it is swept rather than lingering forever.
//
// A lockouts entry is removed when its expiry has passed.
//
// Shards are swept one at a time, so the periodic cleanup never stalls the
// whole limiter at once.
func (r *RateLimiter) Cleanup() {
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
		// Runs from the StartCleanup background goroutine — no request ctx.
		if err := r.store.CleanupExpiredLockouts(context.Background()); err != nil {
			slog.Warn("ratelimit: failed to clean up expired persisted lockouts", "err", err)
		}
	}
}

// StartCleanup runs Cleanup on a ticker with the given interval until the
// stop channel is closed. It is intended to be called in a goroutine:
//
//	stop := make(chan struct{})
//	go rl.StartCleanup(5*time.Minute, stop)
//
// Closing stop causes the goroutine to exit promptly.
func (r *RateLimiter) StartCleanup(interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			r.Cleanup()
		case <-stop:
			return
		}
	}
}

// Len returns the number of entries currently stored in the windows and
// lockouts maps, summed across all shards. It is primarily useful for
// testing and monitoring.
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
