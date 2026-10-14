package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// userLocks is a refcounted per-user lock. The hub keeps two instances:
//
//   - voiceMod serializes a voice-moderation DB transition with its paired
//     LiveKit call, for BOTH the timeout path (muteForTimeout/unmuteForTimeout)
//     and the manual voice-mod-mute endpoint (round 4, Codex review Part B).
//     Whichever caller takes the lock for a given userID runs its DB write AND
//     its SFU call before the other can start either half of its own pair, so
//     a late unmute from one path can never interleave with a fresh mute from
//     the other (Codex 12), and a rollback on an SFU failure (Codex 14) is
//     guaranteed to run against the same, unchanged DB state its own mute just
//     produced. It is held across a LiveKit RPC.
//   - voiceMember (WP 1D-10) serializes every change to a user's voice
//     membership: the voice_states row, the client's voiceChID/voiceJoinToken
//     and the voice grace entry. Each top-level path takes it once through
//     Hub.voiceLock; the helpers they call never do. No LiveKit RPC runs
//     under it: SFU removals are scoped by identity and join token, so they
//     run after unlock or on removeLiveKitParticipantAsync.
//
// Lock order (outermost first):
//
//	voiceMember(uid) → voiceMod(uid) → seqMu → keyHolderMu → h.mu → ps.mu →
//	c.mu / c.voiceMu / voiceGrace.mu / voiceReconcile.mu
//
// A goroutine holds at most one user's voiceMember lock and never takes it
// while holding any of the locks to its right. The hub dispatch goroutine
// never takes it. A path holding voiceMod never calls a membership path.
//
// Entries are reference-counted and evicted once nobody holds or is waiting
// on them (round 5, Codex review P3): a long-lived server with a large,
// ever-churning population must not grow this map forever.
type userLocks struct {
	mu    syncutil.Mutex
	locks map[int64]*userLockEntry
}

// userLockEntry is one userID's lock plus how many callers currently
// hold it or are waiting to. refs is guarded by userLocks.mu, not the
// entry's own lock — it must be adjusted at the same time as the map lookup
// so a concurrent lock() and the unlocking eviction check can never race
// each other into deleting an entry someone is about to wait on.
type userLockEntry struct {
	mu   syncutil.Mutex
	refs int
}

func newUserLocks() *userLocks {
	return &userLocks{locks: make(map[int64]*userLockEntry)}
}

// lock acquires the per-userID lock, blocking until held, and returns a
// func that releases it — `defer h.voiceMod.lock(userID)()`.
func (v *userLocks) lock(userID int64) func() {
	v.mu.Lock()
	if v.locks == nil {
		v.locks = make(map[int64]*userLockEntry)
	}
	e, ok := v.locks[userID]
	if !ok {
		e = &userLockEntry{}
		v.locks[userID] = e
	}
	e.refs++
	v.mu.Unlock()

	e.mu.Lock()
	return func() { v.unlock(userID, e) }
}

// tryLock lets periodic reconciliation skip users with moderation in flight.
// It never queues behind SFU work outside the sweep's time budget.
func (v *userLocks) tryLock(userID int64) (func(), bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, busy := v.locks[userID]; busy {
		return nil, false
	}
	if v.locks == nil {
		v.locks = make(map[int64]*userLockEntry)
	}
	e := &userLockEntry{refs: 1}
	// The entry is private until it is inserted, so this lock cannot block.
	e.mu.Lock()
	v.locks[userID] = e
	return func() { v.unlock(userID, e) }, true
}

func (v *userLocks) unlock(userID int64, e *userLockEntry) {
	e.mu.Unlock()
	v.mu.Lock()
	e.refs--
	if e.refs == 0 {
		delete(v.locks, userID)
	}
	v.mu.Unlock()
}

// refsForTest reports how many callers hold or wait on userID's lock.
func (v *userLocks) refsForTest(userID int64) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	if e, ok := v.locks[userID]; ok {
		return e.refs
	}
	return 0
}

// voiceLock takes userID's voice membership lock and returns its release.
// See userLocks for the lock order; callers hold none of the hub's locks.
func (h *Hub) voiceLock(userID int64) func() {
	return h.voiceMember.lock(userID)
}

// leaveVoiceLocked runs a client-requested voice leave under c's voice lock.
func (h *Hub) leaveVoiceLocked(c *Client, reason string) {
	defer h.voiceLock(c.userID)()
	h.handleVoiceLeave(c.ctx, c, reason)
}

// leaveParkedVoiceLocked tears down userID's parked membership, if any, under
// the voice lock. Taking the lock first means a teardown that is parking the
// membership right now finishes before the take looks for it.
func (h *Hub) leaveParkedVoiceLocked(userID int64, reason string) {
	defer h.voiceLock(userID)()
	h.leaveParkedVoice(context.Background(), h.voiceGrace.take(userID), reason)
}

// voiceJoinPostCommitRaceHook, when non-nil, runs in voiceJoinPersist after
// the voice_states row is committed and read back, immediately before
// c.setVoiceState. sweepStaleVoicePreDeleteRaceHook, when non-nil, runs in
// sweepStaleVoiceStates after the live-client recheck, immediately before
// LeaveIfMatch. Test-only (always nil in production): together they hold a
// join and the sweep inside the window the voice lock closes (WP 1D-10).
var (
	voiceJoinPostCommitRaceHook      func(*Client)
	sweepStaleVoicePreDeleteRaceHook func(userID, channelID int64, joinedAt string)
)
