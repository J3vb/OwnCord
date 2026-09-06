package auth

import "time"

// SeedTimestampForTest inserts ts directly into key's window, bypassing
// Allow's own time.Now() — the seam a test uses to simulate an old
// submission without a real clock (N2, B5-10 review). window records the
// key's own budget the same way a real Allow call would (item 6, round 3
// review: Cleanup is now per-key-window-aware, so a seeded entry needs one
// to behave like a real caller's key rather than reading as already stale).
// Exported for auth_test only; production code never calls this.
func (r *RateLimiter) SeedTimestampForTest(key string, ts time.Time, window time.Duration) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.windows[key]
	if !ok {
		e = &entry{}
		s.windows[key] = e
	}
	e.window = window
	e.timestamps = append(e.timestamps, ts)
}

// WindowForTest returns the Cleanup horizon currently recorded for key (the
// entry's window field), and whether key has an entry at all. Exported for
// auth_test only — production code has no reason to read this back; it
// only ever feeds Cleanup's own staleness check. Round 4 review: the seam
// a test uses to prove Allow's per-key window ratchets up and never down.
func (r *RateLimiter) WindowForTest(key string) (window time.Duration, ok bool) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.windows[key]
	if !ok {
		return 0, false
	}
	return e.window, true
}
