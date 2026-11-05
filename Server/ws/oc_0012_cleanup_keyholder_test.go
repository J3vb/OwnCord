package ws_test

import (
	"testing"
	"time"
)

// OC-0012: every other voice-removal path re-elects the key holder
// (finishVoiceLeave, the LiveKit webhook, registerNow, rollbackVoiceJoin,
// sweepStaleVoiceStates) — CleanupVoiceForChannel, the channel delete/archive
// path, did not. The voiceKeyHolders entry for a deleted channel then stayed
// populated forever: an unbounded per-deleted-channel leak, and a stale
// IsVoiceKeyHolder verdict for a room that no longer exists.
func TestCleanupVoiceForChannel_ClearsKeyHolder(t *testing.T) {
	hub, database := newVoiceHub(t)
	alice := seedMemberUser(t, database, "ckh-alice")
	vcID := seedVoiceChannel(t, database, "ckh-vc")

	c, send := connectClient(t, hub, alice, 0, 32)

	// Real join flow: elects alice key holder of the one-person room.
	hub.HandleMessageForTest(c, voiceJoinMsg(vcID))
	drainChanTimeout(send, 200*time.Millisecond)
	if !hub.IsVoiceKeyHolder(vcID, alice.ID) {
		t.Fatal("precondition: the sole participant must be the key holder")
	}

	hub.CleanupVoiceForChannel(vcID)

	if hub.IsVoiceKeyHolder(vcID, alice.ID) {
		t.Fatal("voiceKeyHolders still names a holder for a cleaned-up channel")
	}
}
