package voicestate

import (
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

// UserLocks is a refcounted per-user lock. The hub keeps two instances:
//
//   - hubVoice.mod serializes a voice-moderation DB transition with its paired LiveKit
//     call, for BOTH the timeout path (muteForTimeout/unmuteForTimeout) and the
//     manual voice-mod-mute endpoint. Whichever caller takes the lock for a userID
//     runs its DB write AND its SFU call before the other can start either half, so
//     a late unmute from one path never interleaves with a fresh mute from the
//     other, and an SFU-failure rollback runs against the DB state its own mute
//     produced. It is held across a LiveKit RPC.
//   - voiceRegistry.voiceMember serializes every change to a user's voice
//     membership. The lock order for both is in ws/lock_order.go. hubVoice.mod
//     comes right after voiceMember: a membership path may take it, and then waits
//     for a moderation call in flight; a hubVoice.mod holder never takes voiceMember.
//
// R is the rank the instance's entries carry (ws/lock_order.go): voiceMember and
// hubVoice.mod are the same type with different ranks, so the deadlock build
// tells them apart. The map's own mu is a leaf whatever R is.
//
// Entries are reference-counted and evicted once nobody holds or waits on them, so
// a large, ever-churning population does not grow this map forever.
type UserLocks[R syncutil.LockRank] struct {
	mu    syncutil.Ranked[lockrank.Leaf]
	locks map[int64]*userLockEntry[R]
}

// userLockEntry is one userID's lock plus how many callers currently
// hold it or are waiting to. refs is guarded by UserLocks.mu, not the
// entry's own lock — it must be adjusted at the same time as the map lookup
// so a concurrent Lock and the unlocking eviction check can never race
// each other into deleting an entry someone is about to wait on.
type userLockEntry[R syncutil.LockRank] struct {
	mu   syncutil.Ranked[R]
	refs int
}

// NewUserLocks returns an empty UserLocks. The zero value works too.
func NewUserLocks[R syncutil.LockRank]() *UserLocks[R] {
	return &UserLocks[R]{locks: make(map[int64]*userLockEntry[R])}
}

// Lock acquires the per-userID lock, blocking until held, and returns a
// func that releases it — `defer h.voiceHub.mod.Lock(userID)()`.
func (v *UserLocks[R]) Lock(userID int64) func() {
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

// TryLock lets periodic reconciliation skip users with moderation in flight.
// It never queues behind SFU work outside the sweep's time budget.
func (v *UserLocks[R]) TryLock(userID int64) (func(), bool) {
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

func (v *UserLocks[R]) unlock(userID int64, e *userLockEntry[R]) {
	e.mu.Unlock()
	v.mu.Lock()
	e.refs--
	if e.refs == 0 {
		delete(v.locks, userID)
	}
	v.mu.Unlock()
}

// Refs reports how many callers hold or wait on userID's lock. Tests use it to
// wait until a caller is queued.
func (v *UserLocks[R]) Refs(userID int64) int {
	v.mu.Lock()
	defer v.mu.Unlock()
	if e, ok := v.locks[userID]; ok {
		return e.refs
	}
	return 0
}
