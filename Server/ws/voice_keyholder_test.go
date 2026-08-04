package ws

import "testing"

// voiceKeyHolders names the participant whose voice_e2ee_offers the server will
// accept. Any path that removes a participant from voice must re-elect, or the
// map keeps naming someone who is gone: the real lowest-uid participant's rekey
// offers are then rejected with NOT_KEY_HOLDER (which the client does not
// handle) after it has already applied its rotated key locally, splitting keys
// across the room.

// setupVoiceRoom puts users 1 and 2 in voice channel 5 and elects user 1.
func setupVoiceRoom(t *testing.T) (*Hub, *Client, *Client) {
	t.Helper()
	h := newEmitTestHub()

	c1 := NewTestClient(h, 1, make(chan []byte, 8))
	c2 := NewTestClient(h, 2, make(chan []byte, 8))
	h.clients[1] = c1
	h.clients[2] = c2
	c1.setVoiceState(5, "join-token-1")
	c2.setVoiceState(5, "join-token-2")

	h.updateKeyHolder(5)
	if !h.IsVoiceKeyHolder(5, 1) {
		t.Fatal("pre-condition: user 1 (lowest uid) should be the elected key holder")
	}
	return h, c1, c2
}

// The LiveKit participant_left webhook is the media-only-loss path: the WS stays
// up, so nothing else will clean this participant out of voice.
func TestWebhookParticipantLeft_ReelectsKeyHolder(t *testing.T) {
	h, _, _ := setupVoiceRoom(t)

	h.HandleWebhookParticipantLeftForTest(1, 5, "join-token-1")

	if h.IsVoiceKeyHolder(5, 1) {
		t.Error("departed participant is still the key holder")
	}
	if !h.IsVoiceKeyHolder(5, 2) {
		t.Error("key holder was not re-elected to the lowest remaining participant")
	}
}

// A fresh reconnect (lastSeq == 0, e.g. F5) replaces the old connection and
// drops its voice state without transferring it, so the room loses that
// participant — but registerNow never re-elected.
func TestRegisterNow_ReelectsKeyHolderWhenReplacedClientLeavesVoice(t *testing.T) {
	h, _, _ := setupVoiceRoom(t)

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	h.registerNow(replacement, map[int64]bool{5: true})

	if voiceChID := replacement.getVoiceChID(); voiceChID != 0 {
		t.Fatalf("pre-condition: fresh connect should not inherit voice state, got channel %d", voiceChID)
	}
	if h.IsVoiceKeyHolder(5, 1) {
		t.Error("user 1 is still the key holder after its connection left voice")
	}
	if !h.IsVoiceKeyHolder(5, 2) {
		t.Error("key holder was not re-elected to the lowest remaining participant")
	}
}

// The re-election must not fire when the reconnect transfers voice state:
// user 1 is still in the room, so it stays the key holder.
func TestRegisterNow_KeepsKeyHolderWhenVoiceStateTransfers(t *testing.T) {
	h, _, _ := setupVoiceRoom(t)

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect — voice state is preserved
	h.registerNow(replacement, map[int64]bool{5: true})

	if voiceChID := replacement.getVoiceChID(); voiceChID != 5 {
		t.Fatalf("pre-condition: network reconnect should inherit voice state, got channel %d", voiceChID)
	}
	if !h.IsVoiceKeyHolder(5, 1) {
		t.Error("key holder was re-elected away from user 1, which is still in voice")
	}
}
