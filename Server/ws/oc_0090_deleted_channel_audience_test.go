package ws_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// OC-0090: channelReadAudience fails closed on a GetChannel *error*, but a
// deleted channel returns (nil, nil) — and that nil row used to skip the DM
// branch and fall through to the server-wide role scan, broadcasting a
// private DM call's voice_leave to every connected member with base
// READ_MESSAGES. The last-leaver CloseDM path hits exactly this: the channel
// row is already gone when DisconnectFromVoiceInChannel tears the call down.
// A missing row must resolve to an empty READ audience; the leaver still
// hears their own teardown via broadcastVoiceEventWithLeaver's union.
func TestVoiceLeave_DeletedChannel_NotLeakedToNonParticipant(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "delchan-alice")
	bob := seedMemberUser(t, database, "delchan-bob")
	mallory := seedMemberUser(t, database, "delchan-mallory") // connected, READ_MESSAGES, not a participant
	dmID := seedDMChannel(t, database, alice.ID, bob.ID)

	aliceSend := make(chan []byte, 32)
	mallorySend := make(chan []byte, 32)
	aliceClient := ws.NewTestClientWithUser(hub, alice, 0, aliceSend)
	malloryClient := ws.NewTestClientWithUser(hub, mallory, 0, mallorySend)
	hub.Register(aliceClient)
	hub.Register(malloryClient)
	waitRegistered(t, hub, malloryClient)

	hub.HandleMessageForTest(aliceClient, voiceJoinMsg(dmID))
	drainChanTimeout(aliceSend, 200*time.Millisecond)
	drainChanTimeout(mallorySend, 200*time.Millisecond)

	// The DM is closed out from under the call: the channels row (and its
	// CASCADE'd overrides) are gone before the voice teardown runs.
	if err := database.DeleteChannel(context.Background(), dmID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	if !hub.DisconnectFromVoiceInChannel(context.Background(), alice.ID, dmID) {
		t.Fatal("DisconnectFromVoiceInChannel reported the user was not in the channel")
	}

	aliceMsgs := drainChanTimeout(aliceSend, 300*time.Millisecond)
	foundLeave := false
	for _, m := range aliceMsgs {
		if extractType(t, m) == "voice_leave" {
			foundLeave = true
		}
	}
	if !foundLeave {
		t.Error("the evicted participant must still receive voice_leave — it is their only teardown signal")
	}

	malloryMsgs := drainChanTimeout(mallorySend, 300*time.Millisecond)
	for _, m := range malloryMsgs {
		if extractType(t, m) == "voice_leave" {
			t.Fatal("voice_leave for a deleted DM channel leaked to a connected non-participant")
		}
	}
}
