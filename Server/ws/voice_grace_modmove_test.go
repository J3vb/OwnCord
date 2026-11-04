package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// pendingFrameOfType drains c's queue and returns the payload of the first
// frame of type want, or nil.
func pendingFrameOfType(t *testing.T, c *Client, want string) map[string]any {
	t.Helper()
	var found map[string]any
	for {
		select {
		case raw := <-c.send:
			var f struct {
				Type    string         `json:"type"`
				Payload map[string]any `json:"payload"`
			}
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("undecodable frame %q: %v", raw, err)
			}
			if f.Type == want && found == nil {
				found = f.Payload
			}
		default:
			return found
		}
	}
}

// moveParked runs the hub half of a moderator move against m's parked call,
// the two calls handleVoiceModMoveV2 makes: the eviction with the flags, then
// the voice_moved send.
func (h *vmHarness) moveParked(m *vmMember, from, to int64, muted bool) (evicted, sent bool) {
	h.t.Helper()
	evicted = h.hub.EvictForModeratorMove(context.Background(), m.userID, from, muted, false, nil)
	if evicted {
		sent = h.hub.SendToVoiceDevice(m.userID, buildVoiceMoved(to, "", 1))
	}
	h.note("moveParked %s ch%d -> ch%d (evicted=%v sent=%v)", m.name, from, to, evicted, sent)
	h.check()
	return evicted, sent
}

// TestVoiceMembership_ModeratorMoveOfParkedCallFollowsResume pins that a
// moderator move of a member parked in the grace window is a move, not a
// kick: the resume inside the window receives voice_moved for the
// destination, and its re-join there carries the moderator's mute.
func TestVoiceMembership_ModeratorMoveOfParkedCallFollowsResume(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-parked-move-from")
	chB := h.chanOf("vm-parked-move-to")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)

	if evicted, sent := h.moveParked(alice, chA, chB, true); !evicted || !sent {
		t.Fatalf("move of a parked call: evicted=%v sent=%v, want both", evicted, sent)
	}
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row != nil {
		t.Fatalf("the parked membership was not ejected: row=%v err=%v", row, err)
	}

	h.resume(alice)
	if ch := alice.c.voice.channel(); ch != 0 {
		t.Fatalf("resume inherited ch%d after the move", ch)
	}
	moved := pendingFrameOfType(t, alice.c, MsgTypeVoiceMoved)
	if moved == nil || int64(moved["to_channel_id"].(float64)) != chB {
		t.Fatalf("resume got voice_moved %v, want one for ch%d", moved, chB)
	}

	if !h.join(alice, chB) {
		t.Fatalf("re-join of the destination did not complete")
	}
	row, err := h.db.GetVoiceState(context.Background(), alice.userID)
	if err != nil || row == nil || row.ChannelID != chB {
		t.Fatalf("after the re-join row=%v err=%v, want ch%d", row, err, chB)
	}
	if !row.ServerMuted {
		t.Fatalf("the moderator mute did not survive the parked move: %+v", row)
	}
	h.leave(alice)
}

// TestVoiceMembership_ParkedMoveResumeBeforeSend pins the race where the
// resume registers between the eviction and the voice_moved send: the frame
// finds the resumed connection by its stamp instead of being lost.
func TestVoiceMembership_ParkedMoveResumeBeforeSend(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-parked-move-race-from")
	chB := h.chanOf("vm-parked-move-race-to")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	if !h.hub.EvictForModeratorMove(context.Background(), alice.userID, chA, false, true, nil) {
		t.Fatalf("move missed the parked call")
	}
	h.resume(alice)
	if !h.hub.SendToVoiceDevice(alice.userID, buildVoiceMoved(chB, "", 1)) {
		t.Fatalf("voice_moved found no device after the resume collected the move")
	}
	if pendingFrameOfType(t, alice.c, MsgTypeVoiceMoved) == nil {
		t.Fatalf("the resumed connection did not receive voice_moved")
	}
	if _, deafened, _ := alice.c.voice.takeModFlags(); !deafened {
		t.Fatalf("the moderator deafen was not stashed on the resumed connection")
	}
}

// TestVoiceMembership_ParkedMoveDroppedByFreshConnect pins that only a resume
// collects the move: a fresh connect (a reload) gets no voice_moved and no
// stash, and a later send reports the member as reconnecting.
func TestVoiceMembership_ParkedMoveDroppedByFreshConnect(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-parked-move-fresh-from")
	chB := h.chanOf("vm-parked-move-fresh-to")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	if !h.hub.EvictForModeratorMove(context.Background(), alice.userID, chA, true, false, nil) {
		t.Fatalf("move missed the parked call")
	}
	h.connect(alice)
	if h.hub.SendToVoiceDevice(alice.userID, buildVoiceMoved(chB, "", 1)) {
		t.Fatalf("voice_moved was delivered after a fresh connect")
	}
	if pendingFrameOfType(t, alice.c, MsgTypeVoiceMoved) != nil {
		t.Fatalf("a fresh connect received voice_moved")
	}
	if muted, _, _ := alice.c.voice.takeModFlags(); muted {
		t.Fatalf("a fresh connect took the parked move's mute")
	}
}

// TestVoiceMembership_ParkedMoveExpiresWithWindow pins that a kept move does
// not outlive the grace window, and that clearing the flags (the handler's
// failure path) forgets it.
func TestVoiceMembership_ParkedMoveExpiresWithWindow(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-parked-move-expire")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	if !h.hub.EvictForModeratorMove(context.Background(), alice.userID, chA, true, false, nil) {
		t.Fatalf("move missed the parked call")
	}
	g := &h.hub.voiceHub.reg.voiceGrace
	g.mu.Lock()
	g.modMoves[alice.userID].at = time.Now().Add(-2 * time.Minute)
	g.mu.Unlock()
	if h.hub.SendToVoiceDevice(alice.userID, []byte(`{}`)) {
		t.Fatalf("a stale parked move still took a frame")
	}

	g.noteParkedModMove(alice.userID, "", modFlagStash{muted: true})
	h.hub.SetPendingVoiceModFlags(alice.userID, false, false, nil)
	if h.hub.SendToVoiceDevice(alice.userID, []byte(`{}`)) {
		t.Fatalf("clearing the flags left the parked move in place")
	}
}

// TestVoiceMembership_ParkedMoveSurvivesFailedResume pins that a resume whose
// connection dies before the client acts on voice_moved does not use the move
// up: the next resume of the session inside the window receives it again.
func TestVoiceMembership_ParkedMoveSurvivesFailedResume(t *testing.T) {
	withGraceWindow(t, time.Minute)
	h := newVMHarness(t, 1)
	alice := h.members[0]
	chA := h.chanOf("vm-parked-move-retry-from")
	chB := h.chanOf("vm-parked-move-retry-to")

	h.connect(alice)
	h.join(alice, chA)
	h.disconnect(alice, true)
	if evicted, sent := h.moveParked(alice, chA, chB, true); !evicted || !sent {
		t.Fatalf("move of a parked call: evicted=%v sent=%v", evicted, sent)
	}
	h.resume(alice)
	h.disconnect(alice, true) // the handshake failed after registering

	h.resume(alice)
	if pendingFrameOfType(t, alice.c, MsgTypeVoiceMoved) == nil {
		t.Fatalf("the second resume did not receive voice_moved")
	}
	if !h.join(alice, chB) {
		t.Fatalf("re-join of the destination did not complete")
	}
	if row, err := h.db.GetVoiceState(context.Background(), alice.userID); err != nil || row == nil || !row.ServerMuted {
		t.Fatalf("the moderator mute did not survive a failed resume: row=%+v err=%v", row, err)
	}
	h.leave(alice)
}
