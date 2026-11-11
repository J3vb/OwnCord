package ws

// In-memory voice membership: an in-memory half (per-user lock and grace window in
// voiceRegistry, per-connection voiceSlot / Client.voice) and a durable half (the
// voice_states row, via VoiceStore). Writes go only through Hub.begin's handle
// (voice_registry_txn.go); read the slot with c.voice.channel() and c.voice.state().
// voiceMember serializes every change to a user's membership: the row, the slot's channel
// and token, and the grace entry (one exception: the leave retry's deleteJoinRow drops only
// its own exact grace entry after unlock, a no-op as the first attempt took it). Each
// top-level path takes it once through Hub.begin; helpers never do. It may span DB I/O and
// broadcasts but never a LiveKit RPC (SFU removals are identity/token-scoped and run after
// unlock or on removeLiveKitParticipantAsync). A goroutine holds at most one user's lock and
// never takes it while holding a lock to its right; the hub dispatch goroutine never takes
// it; a path that holds voiceHub.mod without this lock never takes it. voiceSlot.voiceMu,
// voiceGrace.mu and the voicestate rejoin/reconcile locks are leaves: no I/O, no other
// lock. voiceHub.mod: voicestate/userlocks.go. Order: lock_order.go.

import (
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/voicestate"
)

type voiceRegistry struct {
	voiceMember voicestate.UserLocks[lockRankVoiceMember] // per-user voice membership lock (Hub.begin)
	voiceGrace  voiceGraceState                           // reconnect grace window (voice_grace.go)
}

// close ends the registry at shutdown: stops every grace timer and drops entries without
// touching the DB (the next boot wipes the rows). Afterwards park arms no timer. Idempotent.
func (r *voiceRegistry) close() {
	r.voiceGrace.close()
}

// slotSnap is a copy of one slot's membership: channel, join token, completion and E2EE
// key. The moderator's pending mute/deafen is not part of it: it moves on every hand-off.
type slotSnap struct {
	chID      int64
	joinToken string
	completed bool
	e2ee      e2eeAnnounce
	watching  []int64
}

type modFlags struct {
	muted, deafened bool
	mutedBy         *int64
}

// voiceSlot is one connection's voice membership, guarded by voiceMu. The zero value is "not in voice".
type voiceSlot struct {
	voiceMu        syncutil.Ranked[lockRankLeaf]
	voiceChID      int64  // voice channel the user is in (0 = not in voice)
	voiceJoinToken string // opaque join-instance token for the current voice session
	// voiceJoinCompleted is true once voiceJoinComplete's supersession guard passed for the
	// current (voiceChID, voiceJoinToken). It starts false at setState (right after the row
	// commits) and resets on every state change. registerNow reads it to decide whether a
	// replaced connection had a completed join to hand off; transferring an undelivered one
	// would make voice_join's guards misread it as an eviction and abandon the join, leaving its row.
	voiceJoinCompleted bool
	e2ee               e2eeAnnounce // the last voice_e2ee_announce (key, signature, video decode list)
	watching           []int64      // users whose screen share this member watches (voice_watch); sorted, replaced and never changed in place
	// pendingModServerMuted/Deafened stash a moderator mute/deafen across a server-driven leave
	// (voice_mod_move), which deletes the row they live in before the re-join. See
	// stashModFlags/takeModFlags.
	pendingModServerMuted    bool
	pendingModServerDeafened bool
	// pendingModServerMutedBy is the stashed mute's owner (nil for manual), so the re-join can
	// tell a timeout-owned mute from a manual one.
	pendingModServerMutedBy *int64
}

func (s *voiceSlot) channel() int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.voiceChID
}

func (s *voiceSlot) state() (int64, string) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.voiceChID, s.voiceJoinToken
}

func (s *voiceSlot) setState(chID int64, joinToken string) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.voiceChID = chID
	s.voiceJoinToken = joinToken
	s.voiceJoinCompleted = false
	s.watching = nil // a new join instance watches nothing yet
}

func (s *voiceSlot) adoptJoinToken(joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID == 0 || s.voiceJoinToken != "" {
		return false
	}
	s.voiceJoinToken = joinToken
	return true
}

// markCompletedIfMatch records that the join for (chID, joinToken) passed the supersession
// guard, only if the slot is still exactly that instance, re-checked under the same lock so
// a superseded state cannot be marked done between the guard and this call.
func (s *voiceSlot) markCompletedIfMatch(chID int64, joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID || s.voiceJoinToken != joinToken {
		return false
	}
	s.voiceJoinCompleted = true
	return true
}

func (s *voiceSlot) snapLocked() slotSnap {
	return slotSnap{chID: s.voiceChID, joinToken: s.voiceJoinToken, completed: s.voiceJoinCompleted, e2ee: s.e2ee, watching: s.watching}
}

func (s *voiceSlot) resetLocked() {
	s.voiceChID = 0
	s.voiceJoinToken = ""
	s.voiceJoinCompleted = false
	s.e2ee = e2eeAnnounce{}
	s.watching = nil
}

// clearState clears the membership and returns the old channel, token and completion, which
// registerNow consults before handing a resuming connection this state.
func (s *voiceSlot) clearState() (int64, string, bool) {
	snap := s.clearSnap()
	return snap.chID, snap.joinToken, snap.completed
}

func (s *voiceSlot) clearSnap() slotSnap {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	snap := s.snapLocked()
	s.resetLocked()
	return snap
}

// clearIfChannel clears only when the channel is chID, returning the token and whether it
// cleared, so a later-committed membership survives a delayed eviction.
func (s *voiceSlot) clearIfChannel(chID int64) (string, bool) {
	snap, ok := s.clearSnapIfChannel(chID)
	return snap.joinToken, ok
}

func (s *voiceSlot) clearSnapIfChannel(chID int64) (slotSnap, bool) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID {
		return slotSnap{}, false
	}
	snap := s.snapLocked()
	s.resetLocked()
	return snap, true
}

// clearExact clears only while the slot names this exact join instance; a same-channel
// rejoin has a new token and survives.
func (s *voiceSlot) clearExact(chID int64, joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID || s.voiceJoinToken != joinToken {
		return false
	}
	s.resetLocked()
	return true
}

// drainAll empties the whole slot (membership and moderator stash) in one critical section; voiceTxn.transfer
// is its only caller (TestVoiceRegistry_TransferCarriesEveryField pins that every field is covered).
func (s *voiceSlot) drainAll() (slotSnap, modFlags) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	snap := s.snapLocked()
	s.resetLocked()
	flags := modFlags{muted: s.pendingModServerMuted, deafened: s.pendingModServerDeafened, mutedBy: s.pendingModServerMutedBy}
	s.pendingModServerMuted = false
	s.pendingModServerDeafened = false
	s.pendingModServerMutedBy = nil
	return snap, flags
}

func (s *voiceSlot) adopt(snap slotSnap) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != 0 {
		return false
	}
	s.voiceChID = snap.chID
	s.voiceJoinToken = snap.joinToken
	s.voiceJoinCompleted = snap.completed
	s.e2ee = snap.e2ee
	s.watching = snap.watching
	return true
}

// stashModFlags stashes a moderator mute/deafen before a server-driven leave deletes the
// row they live in. Under voiceMu (what clearIfChannel takes for the delete) so the two
// cannot interleave; takeModFlags pairs with it in voice_join when no row is left.
func (s *voiceSlot) stashModFlags(serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.pendingModServerMuted = serverMuted
	s.pendingModServerDeafened = serverDeafened
	s.pendingModServerMutedBy = serverMutedBy
}

// takeModFlags reads and clears the stash so a later ordinary join is unaffected by an unconsumed one.
func (s *voiceSlot) takeModFlags() (serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	serverMuted, serverDeafened, serverMutedBy = s.pendingModServerMuted, s.pendingModServerDeafened, s.pendingModServerMutedBy
	s.pendingModServerMuted = false
	s.pendingModServerDeafened = false
	s.pendingModServerMutedBy = nil
	return serverMuted, serverDeafened, serverMutedBy
}

func (s *voiceSlot) setE2EE(a e2eeAnnounce) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.e2ee = a
}

func (s *voiceSlot) e2eeCopy() e2eeAnnounce {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.e2ee.clone()
}

// setWatchingIfChannel stores a copy of ids as the watched-screen-share set only while the
// slot is in chID, so a frame decided against an old channel cannot land on a newer membership.
func (s *voiceSlot) setWatchingIfChannel(chID int64, ids []int64) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if chID == 0 || s.voiceChID != chID {
		return false
	}
	s.watching = append([]int64(nil), ids...)
	return true
}

func (s *voiceSlot) watchingCopy() []int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return append([]int64(nil), s.watching...)
}

// watchingIfChannel returns a copy only while the slot is in chID, in one voiceMu hold, so a peer that moved
// on is not reported for its old channel.
func (s *voiceSlot) watchingIfChannel(chID int64) []int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if chID == 0 || s.voiceChID != chID {
		return nil
	}
	return append([]int64(nil), s.watching...)
}
