package ws

import (
	"context"
	"slices"
	"testing"

	"github.com/owncord/server/auth"
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

// Both DB-error branches of the READ-audience resolver must deny. The role
// scan underneath them treats whatever channel it is handed as a readable
// non-DM channel, so an unreadable channels row — or an unreadable DM
// participant list — that fell through would resolve to every connected user
// holding base READ_MESSAGES, fanning a private room's voice_state /
// voice_leave out server-wide.
func TestChannelReadAudience_GetChannelErrorDeniesEveryone(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "audience-chan-err")
	chID := mustCreateVoiceChannel(t, database, "audience-room")

	h := NewHub(database, auth.NewRateLimiter(), nil)
	h.clients[uid] = NewTestClient(h, uid, make(chan []byte, 8))

	// Precondition: the role scan really does grant this user READ on this
	// channel, so an empty audience after the fault can only be the deny.
	if got := h.channelReadAudience(ctx, chID); !slices.Contains(got, uid) {
		t.Fatalf("precondition: user %d must be in the READ audience, got %v", uid, got)
	}

	// Make exactly GetChannel fail; roles and channel_overrides keep
	// resolving, so the role scan would still return this user.
	if _, err := database.ExecContext(ctx, `ALTER TABLE channels RENAME TO channels_offline`); err != nil {
		t.Fatalf("rename channels: %v", err)
	}

	if got := h.channelReadAudience(ctx, chID); len(got) != 0 {
		t.Errorf("channelReadAudience resolved %v for an unreadable channel row — an unresolvable channel must deny, not fall through to the role scan", got)
	}
}

// The DM half of the same rule: a DM carries no channel_overrides rows, so its
// participant list is the only membership evidence there is. When that read
// fails there is nothing left to filter on and the audience must be empty.
func TestChannelReadAudience_DMParticipantsErrorDeniesEveryone(t *testing.T) {
	ctx := context.Background()
	database := newHarvestVoiceDB(t)
	alice := seedHarvestVoiceUser(t, database, "audience-dm-alice")
	bob := seedHarvestVoiceUser(t, database, "audience-dm-bob")
	mallory := seedHarvestVoiceUser(t, database, "audience-dm-mallory")
	dm, _, err := database.GetOrCreateDMChannel(ctx, alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)
	for _, uid := range []int64{alice, bob, mallory} {
		h.clients[uid] = NewTestClient(h, uid, make(chan []byte, 8))
	}

	// Precondition: the DM resolves to its participants only — mallory is
	// connected and holds base READ_MESSAGES, but is not in this DM.
	if got := h.channelReadAudience(ctx, dm.ID); !slices.Contains(got, alice) ||
		!slices.Contains(got, bob) || slices.Contains(got, mallory) {
		t.Fatalf("precondition: DM audience must be exactly participants %d and %d, got %v", alice, bob, got)
	}

	// Make exactly GetDMParticipantIDs fail; the channels row still resolves
	// as type "dm", so the resolver reaches the DM branch and nothing else.
	if _, err := database.ExecContext(ctx, `ALTER TABLE dm_participants RENAME TO dm_participants_offline`); err != nil {
		t.Fatalf("rename dm_participants: %v", err)
	}

	if got := h.channelReadAudience(ctx, dm.ID); len(got) != 0 {
		t.Errorf("channelReadAudience resolved %v for a DM whose participant list could not be read — an unresolvable DM must deny", got)
	}
}
