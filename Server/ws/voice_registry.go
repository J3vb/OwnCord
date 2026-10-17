package ws

// voice_registry.go — WP 5.3a: the in-memory voice membership in one place.
//
// A user's voice membership has an in-memory half and a durable half. The
// in-memory half is the per-user membership lock and the RT-8 grace window,
// held by voiceRegistry (embedded in Hub), and the per-connection slot, held
// by voiceSlot (embedded in Client). The durable half is the voice_states row,
// written through VoiceStore.
//
// 5.3a moved the state here without changing who writes it or which lock
// guards it: the fields keep their names, so every existing reader and test
// reaches them unchanged through Go's field promotion, and the old Client
// accessors stay as one-line delegators. 5.3b (voice_registry_txn.go) routes
// every membership write through the lock handle Hub.begin returns; whole-slot
// hand-off and shutdown are 5.3c.
//
// Lock order (outermost first) — unchanged by the move; voiceSlot.voiceMu is
// the old Client.voiceMu:
//
//	voiceMember(uid) → voiceMod(uid) → seqMu → keyHolderMu → h.mu → ps.mu →
//	c.mu / voiceSlot.voiceMu / voiceGrace.mu / voiceReconcile.mu
//
// voiceMember (WP 1D-10) serializes every change to a user's voice
// membership: the voice_states row, the slot's channel and join token, and
// the grace entry. (The one exception: the leave retry goroutine's deleteRow
// drops only its own exact (channel, token) grace entry after the lock is
// released, which is a no-op because the first attempt already took it.) Each
// top-level path takes it once through Hub.begin (WP
// 5.3b, voice_registry_txn.go); the helpers they call never do. It may span
// DB I/O and broadcasts but never a LiveKit RPC: SFU removals are scoped by identity and join token, so they
// run after unlock or on removeLiveKitParticipantAsync. A goroutine holds at
// most one user's voiceMember lock and never takes it while holding any lock
// to its right. The hub dispatch goroutine never takes it. A path holding
// voiceMod never calls a membership path. The locks in the last row are
// leaves: they do no I/O and take no other lock. voiceMod is described in
// user_locks.go.

import "github.com/J3vb/OwnCord/Server/syncutil"

// voiceRegistry is the hub's in-memory voice membership: the per-user
// membership lock and the reconnect grace window. Both zero values are ready
// to use, so a Hub literal in a test needs no constructor.
type voiceRegistry struct {
	voiceMember userLocks       // per-user voice membership lock (Hub.begin)
	voiceGrace  voiceGraceState // RT-8 grace window (voice_grace.go)
}

// voiceSlot is one connection's voice membership. Every field is guarded by
// voiceMu. The zero value is "not in voice", so a &Client{} literal in a test
// has a usable slot without a constructor.
type voiceSlot struct {
	voiceMu        syncutil.Mutex
	voiceChID      int64  // voice channel the user is in (0 = not in voice)
	voiceJoinToken string // opaque join-instance token for the current voice session
	// voiceJoinCompleted is true once voiceJoinComplete's supersession guard
	// has passed for the current (voiceChID, voiceJoinToken) pair — i.e. the
	// join actually reached the SFU handoff (token sent, voice topic
	// subscribed, voice_state broadcast). It starts false the moment
	// voiceJoinPersist calls setVoiceState (BUG-088, immediately after the DB
	// row commits but well before completion) and is reset to false by every
	// state change, so it is true only while a real, deliverable membership
	// is live. registerNow reads it (via clearVoiceState) to decide whether a
	// network reconnect's replaced connection had a completed join to hand
	// off, or only a persisted-but-not-yet-delivered one still racing its own
	// supersession guards in voice_join.go — transferring the latter makes
	// those guards misread the transfer as an eviction and abandon the join
	// while its voice_states row stays behind for nothing to reap (OC-0270).
	voiceJoinCompleted bool
	e2ee               e2eeAnnounce // the last voice_e2ee_announce (key, signature, video decode list)
	// pendingModServerMuted/pendingModServerDeafened stash a moderator-imposed
	// mute/deafen across a server-driven leave (voice_mod_move), which deletes
	// the voice_states row those flags normally live in before the target's
	// own re-join can read them back. See stashModFlags/takeModFlags.
	pendingModServerMuted    bool
	pendingModServerDeafened bool
	// pendingModServerMutedBy is the stashed mute's owner (round 5, Codex
	// review P2) — nil for a manual mute; carried the same way as the two
	// booleans above so the re-join's restore can tell a timeout-owned mute
	// from a manual one.
	pendingModServerMutedBy *int64
}

// channel returns the voice channel ID (0 = not in voice).
func (s *voiceSlot) channel() int64 {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.voiceChID
}

// state returns the voice channel ID and join token together.
func (s *voiceSlot) state() (int64, string) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.voiceChID, s.voiceJoinToken
}

// setState starts a new join instance on (chID, joinToken).
func (s *voiceSlot) setState(chID int64, joinToken string) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.voiceChID = chID
	s.voiceJoinToken = joinToken
	// A new join instance starts (BUG-088 sets this before the token round
	// trip and completion guard even run); only voiceJoinComplete may mark it
	// done, via markCompletedIfMatch.
	s.voiceJoinCompleted = false
}

// adoptJoinToken sets the join token only when the slot is in a channel and
// holds no token yet, reporting whether it did. Nothing else changes, the
// completed flag included.
func (s *voiceSlot) adoptJoinToken(joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID == 0 || s.voiceJoinToken != "" {
		return false
	}
	s.voiceJoinToken = joinToken
	return true
}

// markCompletedIfMatch records that the join for (chID, joinToken) has
// passed voiceJoinComplete's supersession guard, but only if the slot is
// still in exactly that join instance — re-checked under this same lock
// acquisition so nothing can land between voiceJoinComplete's guard check and
// this call and have it silently mark a superseded/cleared state as done.
// Returns whether it matched and was recorded.
func (s *voiceSlot) markCompletedIfMatch(chID int64, joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID || s.voiceJoinToken != joinToken {
		return false
	}
	s.voiceJoinCompleted = true
	return true
}

// clearState clears the membership and returns the old channel ID, join token
// and whether that join had completed (see voiceJoinCompleted) — the last is
// what registerNow consults before handing a resuming connection this state
// (OC-0270).
func (s *voiceSlot) clearState() (int64, string, bool) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	oldChID := s.voiceChID
	oldJoinToken := s.voiceJoinToken
	oldCompleted := s.voiceJoinCompleted
	s.voiceChID = 0
	s.voiceJoinToken = ""
	s.voiceJoinCompleted = false
	s.e2ee = e2eeAnnounce{}
	return oldChID, oldJoinToken, oldCompleted
}

// clearIfChannel clears the membership only when the current channel is chID,
// returning the join token and whether it cleared. Delayed evictions decided
// against a snapshotted channel use it so a membership committed after the
// snapshot survives — the in-memory analogue of LeaveVoiceChannelIfMatch.
func (s *voiceSlot) clearIfChannel(chID int64) (string, bool) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID {
		return "", false
	}
	oldJoinToken := s.voiceJoinToken
	s.voiceChID = 0
	s.voiceJoinToken = ""
	s.voiceJoinCompleted = false
	s.e2ee = e2eeAnnounce{}
	return oldJoinToken, true
}

// clearExact clears the membership only while it still names this exact join
// instance (channel AND token), reporting whether it cleared. Token-scoped
// unlike clearIfChannel: a same-channel rejoin has a new token, and its
// membership must survive.
func (s *voiceSlot) clearExact(chID int64, joinToken string) bool {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if s.voiceChID != chID || s.voiceJoinToken != joinToken {
		return false
	}
	s.voiceChID = 0
	s.voiceJoinToken = ""
	s.voiceJoinCompleted = false
	s.e2ee = e2eeAnnounce{}
	return true
}

// stashModFlags stashes a moderator-imposed mute/deafen before a server-driven
// leave (voice_mod_move) deletes the voice_states row those flags live in.
// Guarded by voiceMu, the same lock clearIfChannel takes for the delete, so
// the stash can never interleave with it. Paired with takeModFlags, which
// the client's own subsequent voice_join consults when there is no live row
// left to read the flags back from (currentChID == 0).
func (s *voiceSlot) stashModFlags(serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.pendingModServerMuted = serverMuted
	s.pendingModServerDeafened = serverDeafened
	s.pendingModServerMutedBy = serverMutedBy
}

// takeModFlags reads and clears the flags stashed by stashModFlags.
// Take-and-clear so an ordinary later join — one not preceded by a moderator
// move — is unaffected by a stash nobody consumed.
func (s *voiceSlot) takeModFlags() (serverMuted, serverDeafened bool, serverMutedBy *int64) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	serverMuted, serverDeafened, serverMutedBy = s.pendingModServerMuted, s.pendingModServerDeafened, s.pendingModServerMutedBy
	s.pendingModServerMuted = false
	s.pendingModServerDeafened = false
	s.pendingModServerMutedBy = nil
	return serverMuted, serverDeafened, serverMutedBy
}

// setE2EE stores the announce, replacing any earlier one. The caller passes
// a value that shares no slice storage with anything it keeps.
func (s *voiceSlot) setE2EE(a e2eeAnnounce) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	s.e2ee = a
}

// e2eeCopy returns a copy of the stored announce that shares no slice storage
// with the slot.
func (s *voiceSlot) e2eeCopy() e2eeAnnounce {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	return s.e2ee.clone()
}
