package ws

import (
	"context"
	"testing"
	"time"
)

// joinedIdentity joins m to a fresh channel and returns the channel and the
// SFU identity of that join.
func joinedIdentity(t *testing.T, h *vmHarness, m *vmMember, name string) (int64, string) {
	t.Helper()
	chID := h.chanOf(name)
	h.connect(m)
	if !h.join(m, chID) {
		t.Fatal("setup join did not complete")
	}
	_, token := m.c.voice.state()
	return chID, participantIdentity(m.userID, token)
}

// waitRemoved waits until the removal of identity has reached the fake SFU
// and the watch remembers it.
func waitRemoved(t *testing.T, h *vmHarness, chID int64, identity string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for h.sfu.has(RoomName(chID), identity) || !h.hub.livekit.removed.pending() {
		if time.Now().After(deadline) {
			t.Fatalf("removal of %q never reached the SFU", identity)
		}
		time.Sleep(time.Millisecond)
	}
}

func (h *vmHarness) watchTick() {
	h.t.Helper()
	h.hub.enforceRemovedVoiceIdentities(context.Background(), true)
}

// TestVoiceRemovedWatch_RemovesReturningIdentity: after a moderator removal,
// the removed identity reappearing in the room is removed on the next tick.
func TestVoiceRemovedWatch_RemovesReturningIdentity(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-evict")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)

	h.sfu.add(RoomName(chID), identity)
	h.watchTick()
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("identity %q still in the room after a watch tick", identity)
	}
}

// TestVoiceRemovedWatch_LeavesFreshJoinAlone: a later join has a new token, so
// the watch removes only the old identity and keeps the new membership.
func TestVoiceRemovedWatch_LeavesFreshJoinAlone(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, oldIdentity := joinedIdentity(t, h, alice, "watch-rejoin")

	h.leave(alice)
	waitRemoved(t, h, chID, oldIdentity)

	if !h.join(alice, chID) {
		t.Fatal("rejoin did not complete")
	}
	_, token := alice.c.voice.state()
	newIdentity := participantIdentity(alice.userID, token)
	if newIdentity == oldIdentity {
		t.Fatal("rejoin reused the old identity")
	}

	h.sfu.add(RoomName(chID), oldIdentity)
	h.watchTick()
	if h.sfu.has(RoomName(chID), oldIdentity) {
		t.Fatalf("old identity %q still in the room", oldIdentity)
	}
	if !h.sfu.has(RoomName(chID), newIdentity) {
		t.Fatalf("watch removed the fresh join %q", newIdentity)
	}
	if row := h.rowOf(alice); row == nil || row.ChannelID != chID {
		t.Fatalf("fresh membership lost: row=%v", row)
	}
	h.check()
}

// TestVoiceRemovedWatch_ListFailureRetries: a failed room listing keeps the
// entry, and the next tick removes the identity.
func TestVoiceRemovedWatch_ListFailureRetries(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-listfail")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)
	h.sfu.add(RoomName(chID), identity)

	h.sfu.setListFailure(true)
	h.watchTick()
	if !h.hub.livekit.removed.pending() {
		t.Fatal("a failed listing dropped the remembered identity")
	}

	h.sfu.setListFailure(false)
	h.watchTick()
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("identity %q still in the room after the retry tick", identity)
	}
}

// TestVoiceRemovedWatch_ExpiresAfterWindow: once no token for the identity
// can still be valid, the entry is dropped and the room is not listed.
func TestVoiceRemovedWatch_ExpiresAfterWindow(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-expiry")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)

	later := time.Now().Add(voiceRemovedWatchWindow + time.Second)
	h.hub.livekit.removed.mu.Lock()
	h.hub.livekit.removed.now = func() time.Time { return later }
	h.hub.livekit.removed.mu.Unlock()

	h.sfu.setListFailure(true) // an expired entry must not even list the room
	h.watchTick()
	if h.hub.livekit.removed.pending() {
		t.Fatal("entry survived past the watch window")
	}
}

// TestRemovedIdentities_SkipsLegacyIdentity: an identity without a join token
// names the user, not one join, so it is never remembered.
func TestRemovedIdentities_SkipsLegacyIdentity(t *testing.T) {
	var s removedIdentities
	s.record(1, 2, "", false)
	if s.pending() {
		t.Fatal("legacy identity without a join token was remembered")
	}
	s.record(1, 2, "tok", false)
	if !s.pending() {
		t.Fatal("identity with a join token was not remembered")
	}
}

// TestRemovedIdentities_RecordExtendsExpiry: removing the same identity again
// restarts its window.
func TestRemovedIdentities_RecordExtendsExpiry(t *testing.T) {
	start := time.Now()
	now := start
	s := removedIdentities{now: func() time.Time { return now }}
	s.record(1, 2, "tok", false)
	now = start.Add(voiceRemovedWatchWindow - time.Second)
	s.record(1, 2, "tok", false)
	now = start.Add(voiceRemovedWatchWindow + time.Second)
	if len(s.snapshot(true)) != 1 {
		t.Fatal("a repeat removal did not restart the entry's window")
	}
}

// TestVoiceRemovedWatch_KeepsLiveMembership: an identity whose user's
// connection is still in that join is left in the room, and stays remembered.
func TestVoiceRemovedWatch_KeepsLiveMembership(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-live")
	_, token := alice.c.voice.state()

	h.hub.livekit.removed.record(chID, alice.userID, token, false)
	h.watchTick()
	if !h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("watch removed live membership %q", identity)
	}
	if !h.hub.livekit.removed.pending() {
		t.Fatal("a live row made the watch forget the identity")
	}
	h.check()
}

// TestVoiceRemovedWatch_RunningHubRemovesWithoutManualTick: the running hub's
// own watch loop removes a returning identity within a couple of intervals.
func TestVoiceRemovedWatch_RunningHubRemovesWithoutManualTick(t *testing.T) {
	t.Parallel()
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-loop")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)
	h.sfu.add(RoomName(chID), identity)

	deadline := time.Now().Add(3 * voiceRemovedWatchInterval)
	for h.sfu.has(RoomName(chID), identity) {
		if time.Now().After(deadline) {
			t.Fatalf("watch loop left %q in the room for %v", identity, 3*voiceRemovedWatchInterval)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestVoiceRemovedWatch_StoredRowAloneDoesNotKeepIdentity: once the
// connection has left the join, a voice_states row still naming it does not
// keep the identity in the room.
func TestVoiceRemovedWatch_StoredRowAloneDoesNotKeepIdentity(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-stored-row")
	_, token := alice.c.voice.state()

	alice.c.voice.setState(0, "")
	h.hub.livekit.removed.record(chID, alice.userID, token, false)
	h.watchTick()
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("a stored row kept %q in the room after its connection left", identity)
	}
}

// TestRemovedIdentities_MintExtendsExpiry: a token minted for a remembered
// identity restarts its window, so the window outlasts that token.
func TestRemovedIdentities_MintExtendsExpiry(t *testing.T) {
	start := time.Now()
	now := start
	lk := &LiveKitClient{apiKey: "test-key", apiSecret: "test-secret-at-least-32-bytes-long"}
	lk.removed.now = func() time.Time { return now }

	lk.removed.record(7, 42, "tok", false)
	now = start.Add(voiceRemovedWatchWindow - time.Second)
	if _, err := lk.GenerateToken(42, "u", 7, "tok", true, false, false); err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	now = start.Add(voiceRemovedWatchWindow + time.Second)
	if len(lk.removed.snapshot(true)) != 1 {
		t.Fatal("a token minted for a remembered identity did not restart its window")
	}
}

// TestRemovedIdentities_MintLeavesOthersAlone: minting never adds an entry.
func TestRemovedIdentities_MintLeavesOthersAlone(t *testing.T) {
	lk := &LiveKitClient{apiKey: "test-key", apiSecret: "test-secret-at-least-32-bytes-long"}
	if _, err := lk.GenerateToken(42, "u", 7, "tok", true, false, false); err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if lk.removed.pending() {
		t.Fatal("minting a token remembered an identity nobody removed")
	}
}

// TestVoiceRemovedWatch_OwnLeaveCheckedOnSlowCadence: after the client's own
// voice_leave the identity is skipped by an ordinary tick and still removed by
// the own-leave tick, so a rejoin with the old token does not stay in the room.
func TestVoiceRemovedWatch_OwnLeaveCheckedOnSlowCadence(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-own-leave")

	h.leave(alice)
	waitRemoved(t, h, chID, identity)

	h.sfu.add(RoomName(chID), identity)
	h.hub.enforceRemovedVoiceIdentities(context.Background(), false)
	if !h.sfu.has(RoomName(chID), identity) {
		t.Fatal("an ordinary tick checked an own-leave identity")
	}
	h.hub.enforceRemovedVoiceIdentities(context.Background(), true)
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("own-leave identity %q still in the room after the own-leave tick", identity)
	}
}

// TestRemovedIdentities_ForcedRemovalStaysOnFastCadence: an own-leave record
// never downgrades an identity a forced removal already recorded, while a forced
// removal upgrades an own-leave one.
func TestRemovedIdentities_ForcedRemovalStaysOnFastCadence(t *testing.T) {
	var s removedIdentities
	s.record(1, 2, "forced", false)
	s.record(1, 2, "forced", true)
	s.record(1, 3, "own", true)
	got := s.snapshot(false)[1]
	if _, ok := got[participantIdentity(2, "forced")]; !ok {
		t.Fatal("an own-leave record moved a forced removal to the slow cadence")
	}
	if _, ok := got[participantIdentity(3, "own")]; ok {
		t.Fatal("an own-leave identity was listed on an ordinary tick")
	}
	s.record(1, 3, "own", false)
	if _, ok := s.snapshot(false)[1][participantIdentity(3, "own")]; !ok {
		t.Fatal("a forced removal did not move an own-leave identity to the fast cadence")
	}
}

func TestVoiceLeaveIsOwn(t *testing.T) {
	own := map[string]bool{
		voiceLeaveReasonClient: true, voiceLeaveReasonSwitch: true, VoiceLeaveReasonDMLeave: true,
		voiceLeaveReasonMoved: false, voiceLeaveReasonDisconnect: false, voiceLeaveReasonHandshake: false,
		voiceLeaveReasonModerator: false, VoiceLeaveReasonDMRemoved: false, VoiceLeaveReasonBlocked: false,
		voiceLeaveReasonTokenRefresh: false, voiceLeaveReasonRevoked: false, voiceLeaveReasonReconciled: false,
		voiceLeaveReasonGraceExpired: false, voiceLeaveReasonAFK: false, voiceLeaveReasonUnconfirmed: false,
	}
	for reason, want := range own {
		if got := voiceLeaveIsOwn(reason); got != want {
			t.Errorf("voiceLeaveIsOwn(%q) = %v, want %v", reason, got, want)
		}
	}
}

// TestVoiceRemovedWatch_SightingRestartsWindow: an identity the watch finds
// back in its room stays remembered for a full window from that sighting.
func TestVoiceRemovedWatch_SightingRestartsWindow(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-sighting")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)

	start := time.Now()
	now := start
	removed := &h.hub.livekit.removed
	removed.mu.Lock()
	removed.now = func() time.Time { return now }
	removed.mu.Unlock()
	setNow := func(at time.Time) {
		removed.mu.Lock()
		now = at
		removed.mu.Unlock()
	}

	setNow(start.Add(voiceRemovedWatchWindow - time.Minute))
	h.sfu.add(RoomName(chID), identity)
	h.watchTick()
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("identity %q still in the room after a watch tick", identity)
	}

	// Past the first window, inside the one the sighting started.
	setNow(start.Add(voiceRemovedWatchWindow + time.Minute))
	h.sfu.add(RoomName(chID), identity)
	h.watchTick()
	if h.sfu.has(RoomName(chID), identity) {
		t.Fatalf("identity %q came back after its first window and was not removed", identity)
	}
}
