package ws_test

import (
	"context"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

// F11: voice_join and voice_token_refresh authorized the client-supplied channel
// id with a role-only permission check. DM channels carry no channel_overrides,
// so a default Member's base CONNECT_VOICE bit satisfied that check for ANY dm
// channel id and the server minted a LiveKit RoomJoin+CanSubscribe token for a
// conversation the caller is not part of (and then fed them the other
// participants' voice_e2ee_announce keys). Both entry points must consult DM
// membership; both must still work for a genuine participant.

// assertNoVoiceToken asserts that no LiveKit token reached the client and that a
// FORBIDDEN error did.
func assertNoVoiceToken(t *testing.T, msgs [][]byte) {
	t.Helper()
	for _, m := range msgs {
		if extractType(t, m) == "voice_token" {
			t.Fatal("a LiveKit room token was issued for a DM the user is not a participant of")
		}
	}
	found := false
	for _, m := range msgs {
		if extractCode(t, m) == "FORBIDDEN" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected a FORBIDDEN error for the non-participant")
	}
}

func hasVoiceToken(t *testing.T, msgs [][]byte) bool {
	t.Helper()
	for _, m := range msgs {
		if extractType(t, m) == "voice_token" {
			return true
		}
	}
	return false
}

func TestVoiceJoin_DMNonParticipant_GetsNoTokenAndNoVoiceState(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmvoice-alice")
	bob := seedMemberUser(t, database, "dmvoice-bob")
	mallory := seedMemberUser(t, database, "dmvoice-mallory")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mallory, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(dmID))

	assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))

	state, err := database.GetVoiceState(context.Background(), mallory.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state != nil {
		t.Fatalf("non-participant was persisted into the DM's voice channel (%d)", state.ChannelID)
	}
}

func TestVoiceJoin_DMParticipant_StillJoins(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmvoice-ok-alice")
	bob := seedMemberUser(t, database, "dmvoice-ok-bob")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, alice, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(dmID))

	if !hasVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond)) {
		t.Error("a DM participant must still receive a voice token for their own DM")
	}

	state, err := database.GetVoiceState(context.Background(), alice.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || state.ChannelID != dmID {
		t.Fatalf("participant voice state = %+v, want channel %d", state, dmID)
	}
}

func TestVoiceTokenRefresh_DMNonParticipant_Refused(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmrefresh-alice")
	bob := seedMemberUser(t, database, "dmrefresh-bob")
	mallory := seedMemberUser(t, database, "dmrefresh-mallory")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mallory, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Second entry point: the refresh mints a token from the session's own voice
	// channel id, so it must re-run the same membership check rather than trust
	// that a join once passed.
	ws.SetVoiceChIDForTest(c, dmID)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

	assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))
}

func TestVoiceTokenRefresh_DMParticipant_StillRefreshes(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmrefresh-ok-alice")
	bob := seedMemberUser(t, database, "dmrefresh-ok-bob")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, alice, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(dmID))
	drainChanTimeout(send, 50*time.Millisecond)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

	if !hasVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond)) {
		t.Error("a DM participant must still be able to refresh their voice token")
	}
}
