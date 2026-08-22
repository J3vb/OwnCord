package ws

import "testing"

// oc_0302_pending_mod_flags_transfer_test.go — regression test for OC-0302.
//
// voice_mod_move stashes a moderator-imposed mute/deafen on the target's
// live *Client (setPendingModFlags) immediately before evicting them from
// their current voice channel, because that eviction deletes the
// voice_states row those flags normally live in. The stash is meant to
// survive until the target's own subsequent voice_join reads it back via
// takePendingModFlags (voice_join.go:218) since there is no voice_states row
// left for it to be restored from.
//
// If the target's WebSocket drops and reconnects in that window, registerNow
// builds a brand new *Client for the resumed connection. Its
// client-replacement transfer block copies voice state, join token,
// announced E2EE key, and focused channel from the replaced *Client onto the
// new one — but not pendingModServerMuted/pendingModServerDeafened. The
// stash was the ONLY place that state lived, so a plain reconnect silently
// destroys it: the target's subsequent voice_join finds both flags false and
// restores no mute/deafen at all.
func TestRegisterNow_ReconnectTransfersPendingModFlags(t *testing.T) {
	h := newEmitTestHub()

	old := NewTestClient(h, 1, make(chan []byte, 8))
	h.clients[1] = old
	// Mirrors voice_moderation.go:443 (handleVoiceModMoveV2 stashing the
	// target's server_muted/server_deafened state onto their live *Client
	// right before DisconnectFromVoiceInChannel deletes the voice_states row
	// those flags normally live in).
	old.setPendingModFlags(true, false)

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect, not a fresh connect
	h.registerNow(replacement, nil)

	gotMuted, gotDeafened := replacement.takePendingModFlags()
	if !gotMuted || gotDeafened {
		t.Fatalf("registerNow did not transfer pending mod flags across reconnect: "+
			"replacement.takePendingModFlags() = (%v, %v), want (true, false) "+
			"(the moderator's mute must survive a WS blip during voice_mod_move)",
			gotMuted, gotDeafened)
	}
}
