package ws

import "testing"

// oc_0270_voice_join_resume_incomplete_test.go — regression test for OC-0270.
//
// registerNow transfers a replaced connection's voice state onto a resuming
// client whenever the old client happens to be in voice, with nothing
// distinguishing "the join already completed" (voiceJoinComplete already
// subscribed the voice topic, broadcast voice_state, ran updateKeyHolder)
// from "voiceJoinPersist just committed the DB row and set the client's
// voiceChID, but the join is still stuck inside its own in-flight
// supersession guards" (voice_join.go:423 and :470).
//
// Transferring the latter makes the OLD client's in-flight voice_join
// misread the transfer as an eviction: registerNow clears the old client's
// voice state as part of the handoff, so voice_join's guard — which reads
// c.getVoiceState() on that same old *Client — no longer matches
// (channelID, joinToken) and aborts the join (voice_join.go:417/470: "join
// superseded before token/completion"). voiceJoinComplete then never runs:
// no voice_token is delivered, no voice_state is broadcast, no VoiceTopic
// subscription happens. Meanwhile the persisted voice_states row and the NEW
// client's transferred (chID, token) still agree with each other, so
// sweepStaleVoiceStates (hub_sweep.go:244) never reaps it — the user
// permanently occupies a voice slot with a client that was never handed a
// token and never joined the call.
func TestRegisterNow_ResumeDoesNotTransferIncompleteVoiceJoin(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = old
	// Mirrors voiceJoinPersist (voice_join.go:306): the DB row committed and
	// the client's own voice state was set immediately after (BUG-088), but
	// voiceJoinComplete — the only place that ever marks a join as having
	// survived its supersession guards — has not run yet.
	old.setVoiceState(7, "join-token-in-flight")

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect: eligible for voice-state transfer
	h.registerNow(replacement, map[int64]bool{7: true})

	if got := replacement.getVoiceChID(); got != 0 {
		t.Fatalf("resume transferred an incomplete voice join: replacement voiceChID = %d, want 0 "+
			"(the old join never reached voiceJoinComplete, so the transfer makes its own "+
			"supersession guard abort it — leaving a voice_states row nothing ever reaps)", got)
	}
}

// The completed case must keep working: once a join has actually reached
// voiceJoinComplete's supersession guard, a network reconnect must still
// hand it off to the resuming connection exactly as before.
func TestRegisterNow_ResumeTransfersCompletedVoiceJoin(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = old
	old.setVoiceState(7, "join-token-done")
	if !old.markVoiceJoinCompleteIfMatch(7, "join-token-done") {
		t.Fatal("precondition: markVoiceJoinCompleteIfMatch should succeed for the client's own current state")
	}

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNow(replacement, map[int64]bool{7: true})

	if got := replacement.getVoiceChID(); got != 7 {
		t.Fatalf("resume did not transfer a completed voice join: replacement voiceChID = %d, want 7", got)
	}
}
