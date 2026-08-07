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

// TestFinishVoiceLeave_EvictedUserAlwaysInAudience locks the fix for v021:
// by the time finishVoiceLeave runs, the caller has already cleared the
// evicted client's own voice state, so broadcastVoiceEvent's participant
// union (which checks c.getVoiceChID() == channelID) can no longer find
// them — and voice membership is gated on CONNECT_VOICE alone, so a
// participant without READ_MESSAGES is a supported state that would
// otherwise never receive its own voice_leave teardown signal (the client's
// only trigger for E2EE/LiveKit cleanup on a server-initiated eviction).
// finishVoiceLeave must resolve the audience itself and always include the
// evicted user — WITHOUT losing broadcastVoiceEvent's union of the room's
// remaining participants, who are in the same CONNECT_VOICE-without-READ gap
// the sibling test above covers.
func TestFinishVoiceLeave_EvictedUserAlwaysInAudience(t *testing.T) {
	h := newEmitTestHub()

	evicted := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = evicted
	// The real callers (handleVoiceLeave, handleVoiceLeaveIfStillIn) clear the
	// client's voice state before calling finishVoiceLeave; evicted's
	// getVoiceChID() is already 0 here, exactly like at the real call site.

	outsider := NewTestClient(h, 2, make(chan []byte, 8))
	h.clients[2] = outsider

	// Still in the room the leaver is being removed from, and (bare hub)
	// without READ: they must still be told, or their client keeps a stale
	// E2EE key holder for the channel.
	staying := NewTestClient(h, 3, make(chan []byte, 8))
	h.clients[3] = staying
	staying.setVoiceState(5, "join-token-3")

	otherRoom := NewTestClient(h, 4, make(chan []byte, 8))
	h.clients[4] = otherRoom
	otherRoom.setVoiceState(6, "join-token-4")

	// Empty join token skips the DB delete (leaveVoiceChannelWithRetry treats
	// "" as "nothing to remove") — this bare hub has no DB, matching the
	// bare-hub fail-closed (empty) READ audience the sibling test above
	// exercises for broadcastVoiceEvent.
	h.finishVoiceLeave(context.Background(), evicted, 5, "")

	select {
	case bm := <-h.broadcast:
		if !slices.Contains(bm.recipients, int64(1)) {
			t.Error("evicted user missing from its own voice_leave audience")
		}
		if slices.Contains(bm.recipients, int64(2)) {
			t.Error("non-participant without READ leaked into the audience")
		}
		if !slices.Contains(bm.recipients, int64(3)) {
			t.Error("remaining participant of the leaver's room missing from the audience")
		}
		if slices.Contains(bm.recipients, int64(4)) {
			t.Error("participant of a different room leaked into the audience")
		}
	default:
		t.Fatal("finishVoiceLeave enqueued nothing")
	}
}
