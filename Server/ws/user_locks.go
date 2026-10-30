package ws

import (
	"context"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// userLocks is a refcounted per-user lock. The hub keeps two instances:
//
//   - voiceMod serializes a voice-moderation DB transition with its paired LiveKit
//     call, for BOTH the timeout path (muteForTimeout/unmuteForTimeout) and the
//     manual voice-mod-mute endpoint. Whichever caller takes the lock for a userID
//     runs its DB write AND its SFU call before the other can start either half, so
//     a late unmute from one path never interleaves with a fresh mute from the
//     other, and an SFU-failure rollback runs against the DB state its own mute
//     produced. It is held across a LiveKit RPC.
//   - voiceMember serializes every change to a user's voice membership. It lives in
//     voiceRegistry; the lock order for both is in lock_order.go. voiceMod comes
//     right after voiceMember, and a path holding voiceMod never calls a membership
//     path.
//
// R is the rank the instance's entries carry (lock_order.go): voiceMember and
// voiceMod are the same type with different ranks, so the deadlock build
// tells them apart. The map's own mu is a leaf whatever R is.
//
// Entries are reference-counted and evicted once nobody holds or waits on them, so
// a large, ever-churning population does not grow this map forever.
type userLocks[R syncutil.LockRank] struct {
	mu    syncutil.Ranked[lockRankLeaf]
	locks map[int64]*userLockEntry[R]
}

// userLockEntry is one userID's lock plus how many callers currently
// hold it or are waiting to. refs is guarded by userLocks.mu, not the
// entry's own lock — it must be adjusted at the same time as the map lookup
// so a concurrent lock() and the unlocking eviction check can never race
// each other into deleting an entry someone is about to wait on.
type userLockEntry[R syncutil.LockRank] struct {
	mu   syncutil.Ranked[R]
	refs int
}

func newUserLocks[R syncutil.LockRank]() *userLocks[R] {
	return &userLocks[R]{locks: make(map[int64]*userLockEntry[R])}
}

// lock acquires the per-userID lock, blocking until held, and returns a
// func that releases it — `defer h.voiceMod.lock(userID)()`.
func (v *userLocks[R]) lock(userID int64) func() {
	v.mu.Lock()
	if v.locks == nil {
		v.locks = make(map[int64]*userLockEntry[R])
	}
	e, ok := v.locks[userID]
	if !ok {
		e = &userLockEntry[R]{}
		v.locks[userID] = e
	}
	e.refs++
	v.mu.Unlock()

	e.mu.Lock()
	return func() { v.unlock(userID, e) }
}

// tryLock lets periodic reconciliation skip users with moderation in flight.
// It never queues behind SFU work outside the sweep's time budget.
func (v *userLocks[R]) tryLock(userID int64) (func(), bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, busy := v.locks[userID]; busy {
		return nil, false
	}
	if v.locks == nil {
		v.locks = make(map[int64]*userLockEntry[R])
	}
	e := &userLockEntry[R]{refs: 1}
	// The entry is private until it is inserted, so the try always succeeds
	// and its result carries nothing. It is a try, not a Lock, because v.mu
	// (a leaf) is held: the rank check flags a blocking acquire under it,
	// never a try.
	e.mu.TryLock()
	v.locks[userID] = e
	return func() { v.unlock(userID, e) }, true
}

func (v *userLocks[R]) unlock(userID int64, e *userLockEntry[R]) {
	e.mu.Unlock()
	v.mu.Lock()
	e.refs--
	if e.refs == 0 {
		delete(v.locks, userID)
	}
	v.mu.Unlock()
}

// refsForTest reports how many callers hold or wait on userID's lock.
func (v *userLocks[R]) refsForTest(userID int64) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	if e, ok := v.locks[userID]; ok {
		return e.refs
	}
	return 0
}

// leaveVoiceLocked runs a client-requested voice leave under c's voice lock.
func (h *Hub) leaveVoiceLocked(c *Client, reason string) {
	txn := h.begin(c.userID)
	defer txn.end()
	h.handleVoiceLeave(c.ctx, txn, c, reason)
}

// leaveParkedVoiceLocked tears down userID's parked membership, if any, under
// the voice lock. Taking the lock first means a teardown that is parking the
// membership right now finishes before the take looks for it.
func (h *Hub) leaveParkedVoiceLocked(userID int64, reason string) {
	txn := h.begin(userID)
	defer txn.end()
	h.leaveParkedVoice(context.Background(), txn, txn.takeParked(0), reason)
}

// voiceJoinPostCommitRaceHook, when non-nil, runs in voiceJoinPersist after
// the voice_states row is committed and read back, immediately before
// c.setVoiceState. sweepStaleVoicePreDeleteRaceHook, when non-nil, runs in
// sweepStaleVoiceStates after the live-client recheck, immediately before
// LeaveIfMatch. Test-only (always nil in production): together they hold a
// join and the sweep inside the window the voice lock closes.
var (
	voiceJoinPostCommitRaceHook      func(*Client)
	sweepStaleVoicePreDeleteRaceHook func(userID, channelID int64, joinedAt string)
)
