//go:build !deadlock

package syncutil

// The production methods are the plain lock calls, so the rank costs nothing
// outside the deadlock build.

// TakeRankViolations reports the rank violations since its last call. Ranks
// are checked only in the deadlock build, so here it is always zero.
func TakeRankViolations() int64 { return 0 }

// Lock locks m.
func (m *Ranked[R]) Lock() { m.mu.Lock() }

// Unlock unlocks m.
func (m *Ranked[R]) Unlock() { m.mu.Unlock() }

// TryLock tries to lock m and reports whether it succeeded.
func (m *Ranked[R]) TryLock() bool { return m.mu.TryLock() }

// Lock locks m for writing.
func (m *RankedRW[R]) Lock() { m.mu.Lock() }

// Unlock unlocks m for writing.
func (m *RankedRW[R]) Unlock() { m.mu.Unlock() }

// RLock locks m for reading.
func (m *RankedRW[R]) RLock() { m.mu.RLock() }

// RUnlock undoes one RLock.
func (m *RankedRW[R]) RUnlock() { m.mu.RUnlock() }

// TryLock tries to lock m for writing and reports whether it succeeded.
func (m *RankedRW[R]) TryLock() bool { return m.mu.TryLock() }

// TryRLock tries to lock m for reading and reports whether it succeeded.
func (m *RankedRW[R]) TryRLock() bool { return m.mu.TryRLock() }
