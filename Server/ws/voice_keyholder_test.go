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
	// Both represent settled, already-completed voice sessions (not a join
	// still racing its own supersession guards) — see OC-0270 — so a network
	// reconnect is expected to transfer them.
	c1.markVoiceJoinCompleteIfMatch(5, "join-token-1")
	c2.markVoiceJoinCompleteIfMatch(5, "join-token-2")

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

// The webhook path takes a participant out of voice while the WS stays up, so
// it must also drop the voice-topic subscription — otherwise the client keeps
// receiving that room's voice_e2ee_announce relays (which carry no channel_id
// the client could filter on) for the socket's lifetime, and a later join to a
// different channel TOFU-pins stale cross-room keys.
func TestWebhookParticipantLeft_UnsubscribesVoiceTopic(t *testing.T) {
	h, c1, _ := setupVoiceRoom(t)
	h.pubsub.Subscribe(c1, VoiceTopic(5)) // as the real voice_join flow does

	h.HandleWebhookParticipantLeftForTest(1, 5, "join-token-1")

	h.pubsub.mu.RLock()
	sub := h.pubsub.topics[VoiceTopic(5)][1]
	h.pubsub.mu.RUnlock()
	if sub != nil {
		t.Error("client is still subscribed to the voice topic after webhook participant_left")
	}
}

// A network reconnect (lastSeq > 0) keeps the user in voice, so the resumed
// connection must stay subscribed to the voice topic — the only transport for
// voice_e2ee_announce relays — and must retain the announced E2EE key that
// voice_join replays to future joiners. voice_join cannot repair either after
// the fact: a same-channel rejoin is rejected with ALREADY_JOINED.
func TestRegisterNow_ResumeRestoresVoiceTopicAndE2EEKey(t *testing.T) {
	h, c1, _ := setupVoiceRoom(t)
	c1.setE2EEPubKey("ecdh-pub-1", "identity-sig-1")

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1 // network reconnect — voice state is preserved
	h.registerNow(replacement, map[int64]bool{5: true})

	h.pubsub.mu.RLock()
	sub := h.pubsub.topics[VoiceTopic(5)][1]
	h.pubsub.mu.RUnlock()
	if sub != replacement {
		t.Error("resumed connection is not subscribed to its voice channel's topic")
	}
	key, sig := replacement.getE2EEPubKey()
	if key != "ecdh-pub-1" || sig != "identity-sig-1" {
		t.Errorf("announced E2EE key was not transferred on resume: got key=%q sig=%q", key, sig)
	}
}

// The voice-topic subscription must not depend on READ_MESSAGES: it carries
// only E2EE frames for a channel the user already joined through the
// CONNECT_VOICE-gated voice_join. Only the message-stream ChannelTopic is
// READ-gated.
func TestRegisterNow_ResumeVoiceTopicIgnoresReadGate(t *testing.T) {
	h, _, _ := setupVoiceRoom(t)

	replacement := NewTestClient(h, 1, make(chan []byte, 8))
	replacement.lastSeq = 1
	h.registerNow(replacement, nil) // no READ_MESSAGES anywhere

	h.pubsub.mu.RLock()
	voiceSub := h.pubsub.topics[VoiceTopic(5)][1]
	chanSub := h.pubsub.topics[ChannelTopic(5)][1]
	h.pubsub.mu.RUnlock()
	if voiceSub != replacement {
		t.Error("voice topic subscription must not be gated on READ_MESSAGES")
	}
	if chanSub != nil {
		t.Error("channel topic subscription must stay READ-gated")
	}
}
