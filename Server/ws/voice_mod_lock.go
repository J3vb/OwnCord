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
// Entries are never removed (ponytail: unbounded but one *syncutil.Mutex
// per distinct user ever voice-moderated is a small, bounded-in-practice
// leak — add eviction if a long-lived server with a very large, ever-
// churning moderated population measures it as a real cost).
type voiceModLocks struct {
	mu    syncutil.Mutex
	locks map[int64]*syncutil.Mutex
}

func newVoiceModLocks() *voiceModLocks {
	return &voiceModLocks{locks: make(map[int64]*syncutil.Mutex)}
}

// lock acquires the per-userID lock, blocking until held, and returns a
// func that releases it — `defer voiceMod.lock(userID)()`.
func (v *voiceModLocks) lock(userID int64) func() {
	v.mu.Lock()
	l, ok := v.locks[userID]
	if !ok {
		l = &syncutil.Mutex{}
		v.locks[userID] = l
	}
	v.mu.Unlock()

	l.Lock()
	return l.Unlock
}
