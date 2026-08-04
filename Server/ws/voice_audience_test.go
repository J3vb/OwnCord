package ws

import (
	"context"
	"slices"
	"testing"
)

// Voice membership is gated on CONNECT_VOICE alone (voice_join), but the
// voice_state / voice_leave fan-out filters its audience on READ_MESSAGES. A
// participant in that gap misses the room's own membership events — and the
// client's E2EE key-holder election and forward-secrecy rotation run only off
// the voice_leave WS event, so a departing key holder is never replaced and
// new joiners hang until the e2ee_timeout eject. A room's current
// participants must always be in its voice-event audience; the READ filter
// only decides what outsiders may observe.
//
// The bare test hub resolves an empty (fail-closed) READ audience, which is
// exactly the participant-excluded state the union must repair.
func TestBroadcastVoiceEvent_VoiceParticipantsAlwaysInAudience(t *testing.T) {
	h := newEmitTestHub()

	participant := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = participant
	participant.setVoiceState(5, "join-token-1")

	otherRoom := NewTestClient(h, 2, make(chan []byte, 8))
	h.clients[2] = otherRoom
	otherRoom.setVoiceState(6, "join-token-2")

	outsider := NewTestClient(h, 3, make(chan []byte, 8))
	h.clients[3] = outsider

	h.broadcastVoiceEvent(context.Background(), 5, buildVoiceLeave(5, 1))

	select {
	case bm := <-h.broadcast:
		if !slices.Contains(bm.recipients, int64(1)) {
			t.Error("voice participant missing from its own room's voice-event audience")
		}
		if slices.Contains(bm.recipients, int64(2)) {
			t.Error("participant of a different room leaked into the audience")
		}
		if slices.Contains(bm.recipients, int64(3)) {
			t.Error("non-participant without READ leaked into the audience")
		}
	default:
		t.Fatal("broadcastVoiceEvent enqueued nothing")
	}
}
