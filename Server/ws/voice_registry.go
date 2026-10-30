package ws

// In-memory voice membership. A user's membership has an in-memory half (the
// per-user membership lock and reconnect grace window in voiceRegistry, the
// per-connection slot in voiceSlot / Client.voice) and a durable half (the
// voice_states row, written through VoiceStore).
//
// Writes go only through the handle Hub.begin returns (voice_registry_txn.go): it
// moves the whole slot on a hand-off (voiceTxn.transfer), owns the grace window
// (park, inherit, takeParked) and stops it at shutdown (voiceRegistry.close).
// Callers read the slot with c.voice.channel() and c.voice.state(). Lock order is
// in lock_order.go.
//
// voiceMember serializes every change to a user's voice membership: the
// voice_states row, the slot's channel and join token, and the grace entry. (One
// exception: the leave retry goroutine's deleteJoinRow drops only its own exact
// (channel, token) grace entry after unlock, a no-op because the first attempt
// already took it.) Each top-level path takes it once through Hub.begin; helpers
// never do. It may span DB I/O and broadcasts but never a LiveKit RPC: SFU
// removals are scoped by identity and join token and run after unlock or on
// removeLiveKitParticipantAsync. A goroutine holds at most one user's lock and never
// takes it while holding any lock to its right. The hub dispatch goroutine never
// takes it. A path holding voiceMod never calls a membership path.
// voiceSlot.voiceMu, voiceGrace.mu and voiceReconcile.mu are leaves: no I/O, no
// other lock. voiceMod is described in user_locks.go.

import "github.com/J3vb/OwnCord/Server/syncutil"

// voiceRegistry is the hub's in-memory voice membership: the per-user lock and the
// reconnect grace window. Zero values are ready to use.
type voiceRegistry struct {
	voiceMember userLocks[lockRankVoiceMember] // per-user voice membership lock (Hub.begin)
	voiceGrace  voiceGraceState                // reconnect grace window (voice_grace.go)
}

// close ends the registry at shutdown: it stops every grace timer and drops parked
// entries without touching the database (the next boot wipes the rows). Afterwards
// park clears a slot and arms no timer, so a late readPump park leaves nothing
// running. Safe to call more than once.
func (r *voiceRegistry) close() {
	r.voiceGrace.close()
}

// slotSnap is a copy of one slot's membership: channel, join token, whether the
// join completed (voiceJoinCompleted) and the announced E2EE key. Clears return
// what they removed and a grace entry holds one. The moderator's pending
// mute/deafen is not part of it: it is not a membership and moves on every
// hand-off (voiceTxn.transfer).
type slotSnap struct {
	chID      int64
	joinToken string
	completed bool
	e2ee      e2eeAnnounce
	watching  []int64
}

// modFlags is the moderator-imposed mute/deafen stash (voiceSlot's pendingModServer* fields).
type modFlags struct {
	muted, deafened bool
	mutedBy         *int64
}

// voiceSlot is one connection's voice membership, every field guarded by voiceMu.
// The zero value is "not in voice", so a &Client{} literal in a test works.
type voiceSlot struct {
	voiceMu        syncutil.Ranked[lockRankLeaf]
	voiceChID      int64  // voice channel the user is in (0 = not in voice)
	voiceJoinToken string // opaque join-instance token for the current voice session
	// voiceJoinCompleted is true once voiceJoinComplete's supersession guard passed
	// for the current (voiceChID, voiceJoinToken): the join reached the SFU handoff.
	// It starts false when voiceJoinPersist calls setState (right after the row
	// commits, well before completion) and resets on every state change. registerNow
	// reads it (via clearState) to decide whether a reconnect's replaced connection had
	// a completed join to hand off; transferring a persisted-but-undelivered one would
	// make voice_join's guards misread the transfer as an eviction and abandon the
	// join, leaving its row behind.
	voiceJoinCompleted bool
	e2ee               e2eeAnnounce // the last voice_e2ee_announce (key, signature, video decode list)
	watching           []int64      // users whose screen share this member watches (voice_watch); sorted, replaced and never changed in place
	// pendingModServerMuted/Deafened stash a moderator-imposed mute/deafen across a
	// server-driven leave (voice_mod_move), which deletes the row those flags live in
	// before the target's re-join can read them. See stashModFlags/takeModFlags.
	pendingModServerMuted    bool
	pendingModServerDeafened bool
	// pendingModServerMutedBy is the stashed mute's owner (nil for a manual mute),
	// carried like the booleans so the re-join can tell a timeout-owned mute from a
	// manual one.
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
	// A new join instance starts; only voiceJoinComplete may mark it done, via
	// markCompletedIfMatch.
	s.voiceJoinCompleted = false
	s.watching = nil // a new join instance watches nothing yet
}

// adoptJoinToken sets the join token only when the slot is in a channel and holds
// none, reporting whether it did. Nothing else changes.
func (s *voiceSlot) adoptJoinToken(joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID == 0 || s.voiceJoinToken != "" {
		return false
	}
	s.voiceJoinToken = joinToken
	return true
}

// markCompletedIfMatch records that the join for (chID, joinToken) passed
// voiceJoinComplete's supersession guard, only if the slot is still exactly that
// instance, re-checked under this same lock acquisition so a superseded or cleared
// state cannot be marked done between the guard and this call. Returns whether it
// matched.
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

// resetLocked empties channel, token, completed flag and E2EE key together; the
// caller holds voiceMu.
func (s *voiceSlot) resetLocked() {
	s.voiceChID = 0
	s.voiceJoinToken = ""
	s.voiceJoinCompleted = false
	s.e2ee = e2eeAnnounce{}
	s.watching = nil
}

// clearState clears the membership and returns the old channel, join token and
// whether that join completed, which registerNow consults before handing a
// resuming connection this state.
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

// clearIfChannel clears the membership only when the channel is chID, returning
// the join token and whether it cleared. Delayed evictions decided against a
// snapshotted channel use it so a later-committed membership survives (the
// in-memory analogue of LeaveVoiceChannelIfMatch).
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

// clearExact clears the membership only while it still names this exact join
// instance (channel and token). Unlike clearIfChannel, a same-channel rejoin has a
// new token and its membership survives.
func (s *voiceSlot) clearExact(chID int64, joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID || s.voiceJoinToken != joinToken {
		return false
	}
	s.resetLocked()
	return true
}

// drainAll empties the whole slot (membership and moderator stash) in one
// critical section. voiceTxn.transfer is its only caller; every slot field is read
// here or reset by resetLocked (TestVoiceRegistry_TransferCarriesEveryField pins this).
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

// adopt installs snap as the membership, only while the slot is empty.
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

// stashModFlags stashes a moderator-imposed mute/deafen before a server-driven
// leave (voice_mod_move) deletes the row those flags live in. Under voiceMu, the
// lock clearIfChannel takes for the delete, so the two cannot interleave. Paired
// with takeModFlags, which the target's voice_join consults when no row is left
// (currentChID == 0).
func (s *voiceSlot) stashModFlags(serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.pendingModServerMuted = serverMuted
	s.pendingModServerDeafened = serverDeafened
	s.pendingModServerMutedBy = serverMutedBy
}

// takeModFlags reads and clears the stash, so an ordinary later join is unaffected
// by an unconsumed one.
func (s *voiceSlot) takeModFlags() (serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	serverMuted, serverDeafened, serverMutedBy = s.pendingModServerMuted, s.pendingModServerDeafened, s.pendingModServerMutedBy
	s.pendingModServerMuted = false
	s.pendingModServerDeafened = false
	s.pendingModServerMutedBy = nil
	return serverMuted, serverDeafened, serverMutedBy
}

// setE2EE stores the announce; the caller passes a value sharing no slice storage.
func (s *voiceSlot) setE2EE(a e2eeAnnounce) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.e2ee = a
}

// e2eeCopy returns a copy of the stored announce sharing no storage with the slot.
func (s *voiceSlot) e2eeCopy() e2eeAnnounce {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.e2ee.clone()
}

// setWatchingIfChannel stores a copy of ids as the watched-screen-share set only
// while the slot is in chID (a real channel), so a frame decided against an old
// channel cannot land on a newer membership.
func (s *voiceSlot) setWatchingIfChannel(chID int64, ids []int64) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if chID == 0 || s.voiceChID != chID {
		return false
	}
	s.watching = append([]int64(nil), ids...)
	return true
}

// watchingCopy returns a copy of the set sharing no storage (nil when empty).
func (s *voiceSlot) watchingCopy() []int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return append([]int64(nil), s.watching...)
}

// watchingIfChannel returns a copy only while the slot is in chID, in one voiceMu
// hold, so a peer that moved on is not reported for its old channel.
func (s *voiceSlot) watchingIfChannel(chID int64) []int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if chID == 0 || s.voiceChID != chID {
		return nil
	}
	return append([]int64(nil), s.watching...)
}
