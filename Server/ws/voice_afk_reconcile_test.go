package ws

import "testing"

// Flagging a channel that already has members must take their publish grants
// away at once, not at the next 60 s sweep: ReconcileChannelVoicePermissions
// pushes an UpdateParticipant with no publish rights for each member, and
// leaves a channel nobody is in alone.
func TestReconcileChannelVoicePermissions_RevokesPublishForMembersAlreadyThere(t *testing.T) {
	h := newVMHarness(t, 2)
	alice, bob := h.members[0], h.members[1]
	room, other := h.chanOf("afk-room"), h.chanOf("other-room")

	h.connect(alice)
	h.connect(bob)
	h.join(alice, room)
	h.join(bob, room)

	h.hub.ReconcileChannelVoicePermissions(other)
	if n := len(h.sfu.updates); n != 0 {
		t.Fatalf("an empty channel produced %d UpdateParticipant calls, want 0", n)
	}

	if _, err := h.db.SetAFKChannel(t.Context(), &room); err != nil {
		t.Fatal(err)
	}
	h.hub.ReconcileChannelVoicePermissions(room)

	h.sfu.mu.Lock()
	defer h.sfu.mu.Unlock()
	if len(h.sfu.updates) != 2 {
		t.Fatalf("got %d UpdateParticipant calls, want one per member (2)", len(h.sfu.updates))
	}
	for _, u := range h.sfu.updates {
		perm := u.GetPermission()
		if perm == nil || perm.GetCanPublish() || len(perm.GetCanPublishSources()) != 0 {
			t.Fatalf("member %s kept publish rights after the channel became AFK: %+v", u.GetIdentity(), perm)
		}
	}
}
