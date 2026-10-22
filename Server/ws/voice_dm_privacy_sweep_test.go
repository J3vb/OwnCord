package ws_test

import (
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP 6.8d: the voice sweep re-runs the stay gate for a client already in a 1:1
// DM call, so a counterpart the recipient does not trust is removed once the
// recipient turns "Allow DMs" off, while a trusted one stays.
func TestSweepStaleVoiceStates_DMsOffRemovesUntrustedCounterpart(t *testing.T) {
	hub, database := newVoiceHub(t)
	ctx := context.Background()
	alice := seedMemberUser(t, database, "dmoffsweep-alice")
	bob := seedMemberUser(t, database, "dmoffsweep-bob")
	carol := seedMemberUser(t, database, "dmoffsweep-carol")
	dave := seedMemberUser(t, database, "dmoffsweep-dave")

	// alice and bob are untrusted strangers; carol and dave trust each other.
	untrustedDM, _, err := database.GetOrCreateDMChannel(ctx, alice.ID, bob.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	trustedDM := seedDMChannel(t, database, carol.ID, dave.ID)

	join := func(u *db.User, ch int64) {
		send := make(chan []byte, 32)
		c := ws.NewTestClientWithUser(hub, u, 0, send)
		hub.Register(c)
		waitRegistered(t, hub, c)
		hub.HandleMessageForTest(c, voiceJoinMsg(ch))
		if !hasVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond)) {
			t.Fatalf("%s did not join DM %d", u.Username, ch)
		}
	}
	join(alice, untrustedDM.ID)
	join(carol, trustedDM)

	inCall := func(u *db.User) bool {
		state, err := database.GetVoiceState(ctx, u.ID)
		if err != nil {
			t.Fatalf("GetVoiceState: %v", err)
		}
		return state != nil
	}

	// Both recipients leave the setting on: the sweep removes nobody.
	hub.SweepStaleVoiceStatesForTest()
	if !inCall(alice) || !inCall(carol) {
		t.Fatal("the sweep removed a caller while Allow DMs was on")
	}

	for _, u := range []*db.User{bob, dave} {
		if err = database.SetUserPrivacy(ctx, u.ID, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
			t.Fatalf("SetUserPrivacy: %v", err)
		}
	}
	hub.SweepStaleVoiceStatesForTest()

	if inCall(alice) {
		t.Error("an untrusted counterpart stayed in the call after the recipient turned Allow DMs off")
	}
	if !inCall(carol) {
		t.Error("a trusted counterpart was removed from the call")
	}
}
