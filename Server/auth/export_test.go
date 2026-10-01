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

// LogCertificateFailuresForTest exposes logCertificateFailures so the
// issuance-failure log line can be asserted against an injected failing
// issuer, rather than against a real ACME directory (B6-6).
var LogCertificateFailuresForTest = logCertificateFailures

// TrackServedForTest exposes trackServed so the ACME served-leaf tracking can
// be asserted against an injected issuer rather than a real ACME directory.
var TrackServedForTest = trackServed

// QueuedForTest is how many Acquire callers are waiting for a slot right
// now; QueueCapForTest is the most that may wait. Exported for auth_test only.
func (b *AdmissionBudget) QueuedForTest() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.waiters.Len()
}

func (b *AdmissionBudget) QueueCapForTest() int { return b.queueCap }

// SetAvgHoldForTest sets the measured slot hold time behind the wait
// estimate, standing in for a run of slow compares. Exported for auth_test only.
func (b *AdmissionBudget) SetAvgHoldForTest(d time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.avgHold = d
}

// ProductionBcryptCostForTest is bcryptCost as the package initialised it,
// captured before any TestMain lowers it. Exported for auth_test only.
var ProductionBcryptCostForTest = bcryptCost
