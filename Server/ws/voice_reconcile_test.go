package ws

// voice_reconcile_test.go — RT-3: the polling reconciler's behaviour.
//
// This extends the ARCH-03h harness (voice_membership_harness_test.go): the
// same fake room service, the same seeded members, the same three-way
// membership invariant. The reconciler's own tests cannot use the oracle's
// SFU leg while a ghost is inside its two-tick grace window (that is the very
// inconsistency being tolerated), so they assert the specific behaviour and
// then re-check the invariant once the ghost is reaped.

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// severSFU models the fault no shipped config catches: the SFU participant
// dies with the media path (a severed UDP flow) while the WebSocket stays up,
// so the voice_states row and the client's voiceChID both still name the
// channel. RemoveParticipant is the fake's, not the hub's.
func (h *vmHarness) severSFU(m *vmMember) {
	h.t.Helper()
	ch, token := m.c.getVoiceState()
	if ch == 0 {
		h.failf("%s: severSFU with no voice membership", m.name)
	}
	h.sfu.remove(RoomName(ch), participantIdentity(m.userID, token))
	h.note("severSFU %s (participant gone, WS up)", m.name)
}

// rowOf returns m's current voice_states row, or nil.
func (h *vmHarness) rowOf(m *vmMember) *db.VoiceState {
	h.t.Helper()
	row, err := h.db.GetVoiceState(context.Background(), m.userID)
	if err != nil {
		h.failf("%s: GetVoiceState: %v", m.name, err)
	}
	return row
}

// reconcile runs one tick of the production reconciler. It does NOT run the
// three-way oracle: a ghost inside its grace window is deliberately
// inconsistent, so the RT-3 tests assert directly and check the invariant
// once the reap has happened.
func (h *vmHarness) reconcile() {
	h.step++
	h.t.Helper()
	h.hub.reconcileVoiceMembership()
	h.note("reconcile")
}

// TestVoiceReconcile_ReapsGhostAfterTwoTicks: a member whose SFU participant
// vanished is left alone for one tick (the grace window) and reaped on the
// second, through LeaveIfMatch with reason "reconciled", leaving no row, no
// client voice state and no voice-topic subscription.
func TestVoiceReconcile_ReapsGhostAfterTwoTicks(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("rt3-ghost")
	h.connect(alice)
	if !h.join(alice, chID) {
		t.Fatal("setup join did not complete")
	}
	_, token := alice.c.getVoiceState()

	h.severSFU(alice)

	// Tick 1: the grace window. The ghost must survive.
	buf := captureVoiceLog(t)
	h.reconcile()
	if row := h.rowOf(alice); row == nil || row.ChannelID != chID {
		t.Fatalf("ghost reaped on the first tick, before the two-tick grace: row=%v", row)
	}
	if got := alice.c.getVoiceChID(); got != chID {
		t.Fatalf("ghost's client cleared on the first tick: ch%d, want %d", got, chID)
	}

	// Tick 2: reaped.
	h.reconcile()
	if row := h.rowOf(alice); row != nil {
		t.Fatalf("ghost survived two reconcile ticks: row=%v", row)
	}
	if got := alice.c.getVoiceChID(); got != 0 {
		t.Fatalf("reaped ghost's client still in voice: ch%d, want 0", got)
	}
	if h.hub.SubscribedToVoiceTopicForTest(alice.c, chID) {
		t.Error("reaped ghost still subscribed to the voice topic")
	}
	if reasons := voiceLeaveReasons(buf.String()); len(reasons) != 1 || reasons[0] != voiceLeaveReasonReconciled {
		t.Fatalf("voice leave reasons = %v, want [%q] (the reap must log its reason)", reasons, voiceLeaveReasonReconciled)
	}
	_ = token
}

// TestVoiceReconcile_RemovesOrphanParticipant: an SFU participant with no
// matching voice_states row is removed — the other half of the reconciler.
// The room also holds a healthy member: the reconciler lists rooms with rows,
// so a room with no rows at all is out of scope, but an orphan sharing a room
// with a legitimate membership is exactly the stale participant it must drop.
func TestVoiceReconcile_RemovesOrphanParticipant(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("rt3-orphan")
	h.connect(alice)
	if !h.join(alice, chID) {
		t.Fatal("setup join did not complete")
	}

	// An SFU participant for a user that never joined (no row), sharing the
	// room with alice's legitimate participant.
	orphan := participantIdentity(9999, "orphan-token")
	h.sfu.add(RoomName(chID), orphan)

	h.reconcile()
	if h.sfu.has(RoomName(chID), orphan) {
		t.Fatalf("reconciler left an SFU participant %q with no voice_states row", orphan)
	}
	h.check()
}

// TestVoiceReconcile_JoinDuringTickIsNotOrphan: a join that commits after the
// tick's AllStates snapshot and reaches the SFU before the room is listed is
// absent from the snapshot, but it is a live membership, not an orphan.
func TestVoiceReconcile_JoinDuringTickIsNotOrphan(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chID := h.chanOf("rt3-join-race")
	h.connect(alice)
	h.connect(bob)
	if !h.join(alice, chID) {
		t.Fatal("setup join did not complete")
	}

	joined := false
	h.sfu.beforeNextList(func() { joined = h.join(bob, chID) })
	h.reconcile()
	if !joined {
		t.Fatal("bob's mid-tick join did not complete")
	}
	if !h.sfu.has(RoomName(chID), participantIdentity(bob.userID, rowOfToken(t, h, bob))) {
		t.Fatal("reconciler removed a participant whose join committed after the snapshot")
	}
	h.check()
}

// TestVoiceReconcile_HealthyMembershipUntouched: a completed membership whose
// SFU participant is present survives every tick.
func TestVoiceReconcile_HealthyMembershipUntouched(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chID := h.chanOf("rt3-healthy")
	h.connect(alice)
	h.connect(bob)
	h.join(alice, chID)
	h.join(bob, chID)

	for range 3 {
		h.reconcile()
	}
	if row := h.rowOf(alice); row == nil || row.ChannelID != chID {
		t.Fatalf("reconciler reaped a healthy member: row=%v", row)
	}
	if got := alice.c.getVoiceChID(); got != chID {
		t.Fatalf("reconciler cleared a healthy member: ch%d, want %d", got, chID)
	}
	if !h.sfu.has(RoomName(chID), participantIdentity(alice.userID, rowOfToken(t, h, alice))) {
		t.Fatal("reconciler removed a healthy member's SFU participant")
	}
	h.check()
}

// TestVoiceReconcile_ListFailureDoesNotReap: a transient ListParticipants
// failure must skip the room, not treat its rows as ghosts. Otherwise one
// unavailable SFU would evict every member after two ticks.
func TestVoiceReconcile_ListFailureDoesNotReap(t *testing.T) {
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chID := h.chanOf("rt3-listfail")
	h.connect(alice)
	if !h.join(alice, chID) {
		t.Fatal("setup join did not complete")
	}

	h.sfu.setListFailure(true)
	for range 3 {
		h.reconcile()
	}
	h.sfu.setListFailure(false)

	if row := h.rowOf(alice); row == nil || row.ChannelID != chID {
		t.Fatalf("a ListParticipants failure reaped a healthy member: row=%v", row)
	}
	h.check()
}

// TestVoiceReconcile_ReelectsKeyHolder: when the reaped ghost was the room's
// key holder, the remaining participant is elected after the reap, or the
// room's rekey offers are rejected with NOT_KEY_HOLDER until the next join.
func TestVoiceReconcile_ReelectsKeyHolder(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	chID := h.chanOf("rt3-keyholder")
	h.connect(alice)
	h.connect(bob)
	h.join(alice, chID)
	h.join(bob, chID)

	// alice is the lowest user id, so the room's key holder.
	if !h.hub.IsVoiceKeyHolder(chID, alice.userID) {
		t.Fatalf("precondition: alice (%d) is not the key holder", alice.userID)
	}
	h.severSFU(alice)

	h.reconcile() // grace
	h.reconcile() // reap
	if h.hub.IsVoiceKeyHolder(chID, alice.userID) {
		t.Fatalf("reaped ghost %d is still named key holder for ch%d", alice.userID, chID)
	}
	if !h.hub.IsVoiceKeyHolder(chID, bob.userID) {
		t.Fatalf("key holder was not re-elected to the remaining participant %d", bob.userID)
	}
	h.check()
}

func rowOfToken(t *testing.T, h *vmHarness, m *vmMember) string {
	t.Helper()
	row := h.rowOf(m)
	if row == nil {
		t.Fatalf("%s: no row", m.name)
	}
	return row.JoinedAt
}
