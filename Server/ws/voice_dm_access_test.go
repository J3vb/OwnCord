package ws_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
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

// Group DMs need no separate voice authorization path: dm_participants holds
// one row per participant and the gate is a lookup on (user_id, channel_id).
// These two pin that the existing path genuinely covers the N-participant case
// — a third member gets in, and an outsider still does not.
func TestVoiceJoin_GroupDMParticipant_Joins(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "grpvoice-alice")
	bob := seedMemberUser(t, database, "grpvoice-bob")
	carol := seedMemberUser(t, database, "grpvoice-carol")
	chID := seedGroupDM(t, database, "Callers", alice.ID, bob.ID, carol.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, carol, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chID))

	if !hasVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond)) {
		t.Error("the third member of a group DM must receive a voice token")
	}

	state, err := database.GetVoiceState(context.Background(), carol.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state == nil || state.ChannelID != chID {
		t.Fatalf("group participant voice state = %+v, want channel %d", state, chID)
	}
}

// channelReadAudience used to resolve a DM's audience via the role scan (DMs
// carry no channel_overrides), so any connected user whose base role held
// READ_MESSAGES received the DM call's voice_state/voice_leave events —
// leaking who is in a private call and their mute/camera state to the whole
// server. The audience must be the DM's participants, not a role-wide scan.
func TestVoiceJoin_DMCall_VoiceStateNotLeakedToThirdConnectedUser(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmleak-alice")
	bob := seedMemberUser(t, database, "dmleak-bob")
	mallory := seedMemberUser(t, database, "dmleak-mallory") // connected, has READ_MESSAGES, NOT a participant
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	aliceSend := make(chan []byte, 32)
	bobSend := make(chan []byte, 32)
	mallorySend := make(chan []byte, 32)
	aliceClient := ws.NewTestClientWithUser(hub, alice, 0, aliceSend)
	bobClient := ws.NewTestClientWithUser(hub, bob, 0, bobSend)
	malloryClient := ws.NewTestClientWithUser(hub, mallory, 0, mallorySend)
	hub.Register(aliceClient)
	hub.Register(bobClient)
	hub.Register(malloryClient)
	waitRegistered(t, hub, malloryClient)

	hub.HandleMessageForTest(aliceClient, voiceJoinMsg(dmID))

	bobMsgs := drainChanTimeout(bobSend, 300*time.Millisecond)
	foundVoiceState := false
	for _, m := range bobMsgs {
		if extractType(t, m) == "voice_state" {
			foundVoiceState = true
		}
	}
	if !foundVoiceState {
		t.Error("a DM participant must still receive voice_state for their own DM call")
	}

	malloryMsgs := drainChanTimeout(mallorySend, 300*time.Millisecond)
	for _, m := range malloryMsgs {
		if extractType(t, m) == "voice_state" {
			t.Fatal("voice_state for a DM call leaked to a connected non-participant")
		}
	}
}

// OC-0018: voice_join into a 1:1 DM had no block gate. Every other 1:1-DM
// interaction sink (send, edit, react, pin, typing, call_ring) routes through
// service.requireDMNotBlocked; voice was the one gap. Blocking never touches
// dm_participants (service/block.go), so IsDMParticipant still passes a
// blocked user straight through into the blocker's DM voice room.
func TestVoiceJoin_DMBlocked_Refused(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmblock-alice")
	bob := seedMemberUser(t, database, "dmblock-bob")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, alice, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(dmID))

	assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))

	state, err := database.GetVoiceState(context.Background(), alice.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if state != nil {
		t.Fatalf("blocked user was persisted into the DM's voice channel (%d)", state.ChannelID)
	}
}

// Second entry point: a block imposed mid-session must also evict on the next
// token refresh, not just refuse the initial join. Alice joins while still
// unblocked (so the join succeeds and a real voice_states row exists), then
// bob blocks her; the refresh must re-check and evict rather than keep
// minting fresh SFU room-join credentials for the old session.
func TestVoiceTokenRefresh_DMBlocked_Refused(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "dmblockrefresh-alice")
	bob := seedMemberUser(t, database, "dmblockrefresh-bob")
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, alice, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(dmID))
	drainChanTimeout(send, 50*time.Millisecond)

	if err := database.BlockUser(context.Background(), bob.ID, alice.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())

	assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))
}

func TestVoiceJoin_GroupDMNonParticipant_Refused(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "grpvoice-x-alice")
	bob := seedMemberUser(t, database, "grpvoice-x-bob")
	carol := seedMemberUser(t, database, "grpvoice-x-carol")
	mallory := seedMemberUser(t, database, "grpvoice-x-mallory")
	chID := seedGroupDM(t, database, "Callers", alice.ID, bob.ID, carol.ID)

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mallory, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, voiceJoinMsg(chID))

	assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))
}
