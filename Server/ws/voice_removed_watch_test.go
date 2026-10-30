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
	h.hub.enforceRemovedVoiceIdentities(context.Background())
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

// TestVoiceRemovedWatch_ExpiresAfterTokenTTL: once no token for the identity
// can still be valid, the entry is dropped and the room is not listed.
func TestVoiceRemovedWatch_ExpiresAfterTokenTTL(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-expiry")

	h.evict(alice)
	waitRemoved(t, h, chID, identity)

	later := time.Now().Add(tokenTTL + time.Second)
	h.hub.livekit.removed.mu.Lock()
	h.hub.livekit.removed.now = func() time.Time { return later }
	h.hub.livekit.removed.mu.Unlock()

	h.sfu.setListFailure(true) // an expired entry must not even list the room
	h.watchTick()
	if h.hub.livekit.removed.pending() {
		t.Fatal("entry survived past tokenTTL")
	}
}

// TestRemovedIdentities_SkipsLegacyIdentity: an identity without a join token
// names the user, not one join, so it is never remembered.
func TestRemovedIdentities_SkipsLegacyIdentity(t *testing.T) {
	var s removedIdentities
	s.record(1, 2, "")
	if s.pending() {
		t.Fatal("legacy identity without a join token was remembered")
	}
	s.record(1, 2, "tok")
	if !s.pending() {
		t.Fatal("identity with a join token was not remembered")
	}
}

// TestRemovedIdentities_RecordExtendsExpiry: removing the same identity again
// restarts its tokenTTL window.
func TestRemovedIdentities_RecordExtendsExpiry(t *testing.T) {
	start := time.Now()
	now := start
	s := removedIdentities{now: func() time.Time { return now }}
	s.record(1, 2, "tok")
	now = start.Add(tokenTTL - time.Second)
	s.record(1, 2, "tok")
	now = start.Add(tokenTTL + time.Second)
	if len(s.snapshot()) != 1 {
		t.Fatal("a repeat removal did not restart the entry's tokenTTL window")
	}
}

// TestVoiceRemovedWatch_KeepsLiveMembership: an identity whose user's
// connection is still in that join is left in the room, and stays remembered.
func TestVoiceRemovedWatch_KeepsLiveMembership(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID, identity := joinedIdentity(t, h, alice, "watch-live")
	_, token := alice.c.voice.state()

	h.hub.livekit.removed.record(chID, alice.userID, token)
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
	h.hub.livekit.removed.record(chID, alice.userID, token)
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

	lk.removed.record(7, 42, "tok")
	now = start.Add(tokenTTL - time.Second)
	if _, err := lk.GenerateToken(42, "u", 7, "tok", true, false, false); err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	now = start.Add(tokenTTL + time.Second)
	if len(lk.removed.snapshot()) != 1 {
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
