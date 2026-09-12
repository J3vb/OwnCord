package ws_test

import (
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// oc_0420_pending_mod_flags_join_failure_test.go — regression test for
// OC-0420.
//
// voiceJoinLeaveCurrent (voice_join.go) take-and-clears the moderator
// mute/deafen stash a completed voice_mod_move left on the target's live
// *Client (currentChID == 0, no voice_states row left to read from) so that
// voiceJoinRestoreModFlags can re-apply it once the new row exists. But the
// join has two fallible steps left after that consume: voiceJoinPersist's
// capacity-checked insert and its row re-read. If either fails,
// handleVoiceJoin returns before voiceJoinRestoreModFlags ever runs, and the
// stash — already cleared — is gone from both the client and the DB, with
// nothing left to restore the moderator's restriction on any later join.
func TestVoiceJoin_ChannelFullAfterMove_PreservesPendingModStash(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChanMaxUsers(t, database, "vc-oc0420", 1)

	// Fill the destination to capacity so the target's own re-join (below)
	// fails in voiceJoinPersist — currentChID is 0 for this client (mirroring
	// the state right after a voice_mod_move eviction), so voiceJoinPrecheck's
	// advisory pre-flight is skipped (it only runs when cur > 0) and the
	// atomic insert is the first capacity check to run.
	filler := seedVoiceOwner(t, database, "oc0420-filler")
	fillerSend := make(chan []byte, 32)
	fillerClient := ws.NewTestClientWithUser(hub, filler, chanID, fillerSend)
	hub.Register(fillerClient)
	waitRegistered(t, hub, fillerClient)
	hub.HandleMessageForTest(fillerClient, voiceJoinMsg(chanID))
	drainChanTimeout(fillerSend, 30*time.Millisecond)

	target := seedVoiceOwner(t, database, "oc0420-target")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, target, chanID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Mirrors handleVoiceModMoveV2 stashing the target's server-muted state
	// onto their live connection immediately before the eviction that leaves
	// currentChID == 0 for this join (voice_moderation.go:460).
	if ok := hub.SetPendingVoiceModFlags(target.ID, true, false, nil); !ok {
		t.Fatalf("SetPendingVoiceModFlags: target client not registered on hub")
	}

	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))

	if code := receiveErrorCode(send, waitTimeout); code != "CHANNEL_FULL" {
		t.Fatalf("error code = %q, want CHANNEL_FULL", code)
	}

	if gotMuted, gotDeafened := ws.PeekClientPendingModFlagsForTest(c); !gotMuted || gotDeafened {
		t.Errorf("pending mod stash after a failed join = (muted=%v, deafened=%v), want (true, false): "+
			"a join that fails after consuming the stash must put it back, or a moderator's "+
			"mute is silently dropped and the user joins any channel fully unmuted",
			gotMuted, gotDeafened)
	}
}
