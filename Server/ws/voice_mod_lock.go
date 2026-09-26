package ws

import "github.com/J3vb/OwnCord/Server/syncutil"

// voiceModLocks is a per-target-user lock serializing a voice-moderation DB
// transition with its paired LiveKit call, for BOTH the timeout path
// (muteForTimeout/unmuteForTimeout) and the manual voice-mod-mute endpoint
// (round 4, Codex review Part B). Whichever caller takes the lock for a
// given userID runs its DB write AND its SFU call before the other can
// start either half of its own pair, so a late unmute from one path can
// never interleave with a fresh mute from the other (Codex 12), and a
// rollback on an SFU failure (Codex 14) is guaranteed to run against the
// same, unchanged DB state its own mute just produced.
//
// Entries are reference-counted and evicted once nobody holds or is waiting
// on them (round 5, Codex review P3): a long-lived server moderating a
// large, ever-churning population must not grow this map forever.
type voiceModLocks struct {
	mu    syncutil.Mutex
	locks map[int64]*voiceModLockEntry
}

// voiceModLockEntry is one userID's lock plus how many callers currently
// hold it or are waiting to. refs is guarded by voiceModLocks.mu, not the
// entry's own lock — it must be adjusted at the same time as the map lookup
// so a concurrent lock() and the unlocking eviction check can never race
// each other into deleting an entry someone is about to wait on.
type voiceModLockEntry struct {
	mu   syncutil.Mutex
	refs int
}

func newVoiceModLocks() *voiceModLocks {
	return &voiceModLocks{locks: make(map[int64]*voiceModLockEntry)}
}

// lock acquires the per-userID lock, blocking until held, and returns a
// func that releases it — `defer voiceMod.lock(userID)()`.
func (v *voiceModLocks) lock(userID int64) func() {
	v.mu.Lock()
	e, ok := v.locks[userID]
	if !ok {
		e = &voiceModLockEntry{}
		v.locks[userID] = e
	}
	e.refs++
	v.mu.Unlock()

	e.mu.Lock()
	return func() { v.unlock(userID, e) }
}

// tryLock lets periodic reconciliation skip users with moderation in flight.
// It never queues behind SFU work outside the sweep's time budget.
func (v *voiceModLocks) tryLock(userID int64) (func(), bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, busy := v.locks[userID]; busy {
		return nil, false
	}
	e := &voiceModLockEntry{refs: 1}
	// The entry is private until it is inserted, so this lock cannot block.
	e.mu.Lock()
	v.locks[userID] = e
	return func() { v.unlock(userID, e) }, true
}

func (v *voiceModLocks) unlock(userID int64, e *voiceModLockEntry) {
	e.mu.Unlock()
	v.mu.Lock()
	e.refs--
	if e.refs == 0 {
		delete(v.locks, userID)
	}
	v.mu.Unlock()
}
