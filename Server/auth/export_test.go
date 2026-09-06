package auth

import "time"

// SeedTimestampForTest inserts ts directly into key's window, bypassing
// Allow's own time.Now() — the seam a test uses to simulate an old
// submission without a real clock (N2, B5-10 review: rateLimiterCleanupMaxWindow
// vs a 24h-window caller). Exported for auth_test only; production code
// never calls this.
func (r *RateLimiter) SeedTimestampForTest(key string, ts time.Time) {
	s := r.shardFor(key)
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.windows[key]
	if !ok {
		e = &entry{}
		s.windows[key] = e
	}
	e.timestamps = append(e.timestamps, ts)
}
