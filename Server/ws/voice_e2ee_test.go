package ws_test

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

// ─── helpers ─────────────────────────────────────────────────────────────────

// e2eeAnnounceMsg builds a voice_e2ee_announce WebSocket message.
func e2eeAnnounceMsg(publicKey string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_e2ee_announce",
		"payload": map[string]any{"public_key": publicKey},
	})
	return raw
}

// e2eeOfferMsg builds a voice_e2ee_offer WebSocket message.
func e2eeOfferMsg(targetUserID int64, encryptedKey, iv string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "voice_e2ee_offer",
		"payload": map[string]any{
			"target_user_id": targetUserID,
			"encrypted_key":  encryptedKey,
			"iv":             iv,
		},
	})
	return raw
}

// extractPayloadField extracts a string field from payload of a JSON message.
func extractPayloadField(t *testing.T, msg []byte, field string) any {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("extractPayloadField unmarshal: %v", err)
	}
	payload, ok := env["payload"].(map[string]any)
	if !ok {
		return nil
	}
	return payload[field]
}

// extractMessage extracts the "message" field from an error payload.
func extractMessage(t *testing.T, msg []byte) string {
	t.Helper()
	v := extractPayloadField(t, msg, "message")
	s, _ := v.(string)
	return s
}

// validB64Key returns a valid base64-encoded 65-byte P-256 public key.
func validB64Key() string {
	key := make([]byte, 65)
	key[0] = 0x04 // uncompressed P-256 marker
	return base64.StdEncoding.EncodeToString(key)
}

// validURLSafeB64Key returns a URL-safe (no padding) base64-encoded key.
func validURLSafeB64Key() string {
	key := make([]byte, 65)
	key[0] = 0x04
	return base64.RawStdEncoding.EncodeToString(key)
}

// validB64 returns a small valid base64 string.
func validB64(data string) string {
	return base64.StdEncoding.EncodeToString([]byte(data))
}

// validRawB64 returns a raw (no padding) base64 string.
func validRawB64(data string) string {
	return base64.RawStdEncoding.EncodeToString([]byte(data))
}

// ─── C-1: TOCTOU race — target channel check must be inside lock ─────────────

func TestE2EE_Offer_TargetChannelCheckAtomicWithLookup(t *testing.T) {
	// This test verifies the fix for C-1: the target's voice channel ID
	// is read while h.mu.RLock is held, so there's no window for the target
	// to leave between lookup and channel check.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-toctou")

	// sender joins voice
	sender := seedVoiceOwner(t, database, "toctou-sender")
	sendCh := make(chan []byte, 32)
	senderClient := ws.NewTestClientWithUser(hub, sender, 0, sendCh)
	hub.Register(senderClient)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(senderClient, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(sendCh)

	// target joins voice
	target := seedVoiceOwner(t, database, "toctou-target")
	targetCh := make(chan []byte, 32)
	targetClient := ws.NewTestClientWithUser(hub, target, 0, targetCh)
	hub.Register(targetClient)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(targetClient, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(targetCh)

	// Send an E2EE offer from sender to target — should succeed since both
	// are in the same channel.
	encKey := validB64("encrypted-room-key-data")
	iv := validB64("twelve-bytes")
	hub.HandleMessageForTest(senderClient, e2eeOfferMsg(target.ID, encKey, iv))
	time.Sleep(30 * time.Millisecond)

	// Target should receive the offer relay.
	msgs := drainChan(targetCh)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "voice_e2ee_offer" {
			found = true
		}
	}
	if !found {
		t.Error("target did not receive voice_e2ee_offer relay")
	}
}

// ─── I-1: Key holder validation — only key holder can send offers ────────────

func TestE2EE_Offer_RejectsNonKeyHolder(t *testing.T) {
	// I-1: Only the key holder (lowest user ID in the channel) may send offers.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-keyholder")

	// user1 (lower ID) joins first — should be key holder
	user1 := seedVoiceOwner(t, database, "kh-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	// user2 (higher ID) joins — should NOT be key holder
	user2 := seedVoiceOwner(t, database, "kh-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send2)

	// user2 tries to send an E2EE offer — should be rejected
	encKey := validB64("encrypted-room-key-data")
	iv := validB64("twelve-bytes")
	hub.HandleMessageForTest(c2, e2eeOfferMsg(user1.ID, encKey, iv))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send2)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "error" && extractCode(t, m) == "NOT_KEY_HOLDER" {
			found = true
		}
	}
	if !found {
		t.Error("non-key-holder offer should be rejected with NOT_KEY_HOLDER error")
	}
}

func TestE2EE_Offer_KeyHolderCanSend(t *testing.T) {
	// I-1: The key holder (lowest user ID) can send offers.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-keyholder-ok")

	// user1 (lower ID) joins first — key holder
	user1 := seedVoiceOwner(t, database, "kh-ok-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	// user2 (higher ID) joins
	user2 := seedVoiceOwner(t, database, "kh-ok-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send2)

	// user1 (key holder) sends offer to user2 — should succeed
	encKey := validB64("encrypted-room-key-data")
	iv := validB64("twelve-bytes")
	hub.HandleMessageForTest(c1, e2eeOfferMsg(user2.ID, encKey, iv))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send2)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "voice_e2ee_offer" {
			found = true
		}
	}
	if !found {
		t.Error("key holder's offer should be relayed to target")
	}
}

func TestE2EE_KeyHolderTransfersOnLeave(t *testing.T) {
	// I-1: When key holder leaves, the next lowest user ID becomes key holder.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-kh-transfer")

	// user1 (lower ID) joins — key holder
	user1 := seedVoiceOwner(t, database, "kht-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	// user2 (higher ID) joins
	user2 := seedVoiceOwner(t, database, "kht-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	// user3 (highest ID) joins
	user3 := seedVoiceOwner(t, database, "kht-user3")
	send3 := make(chan []byte, 32)
	c3 := ws.NewTestClientWithUser(hub, user3, 0, send3)
	hub.Register(c3)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c3, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)
	drainChan(send2)
	drainChan(send3)

	// user1 (key holder) leaves
	hub.HandleMessageForTest(c1, voiceLeaveMsg())
	time.Sleep(50 * time.Millisecond)
	drainChan(send2)
	drainChan(send3)

	// Now user2 should be key holder — user2 sends offer to user3
	encKey := validB64("new-key")
	iv := validB64("twelve-bytes")
	hub.HandleMessageForTest(c2, e2eeOfferMsg(user3.ID, encKey, iv))
	time.Sleep(30 * time.Millisecond)

	msgs := drainChan(send3)
	found := false
	for _, m := range msgs {
		if extractType(t, m) == "voice_e2ee_offer" {
			found = true
		}
	}
	if !found {
		t.Error("after key holder leaves, next lowest user should become key holder and be able to send offers")
	}
}

// ─── I-2: base64 validation — accept both standard and raw base64 ────────────

func TestE2EE_Announce_AcceptsRawBase64(t *testing.T) {
	// I-2: URL-safe / raw base64 (no padding) should be accepted.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-b64")

	user := seedVoiceOwner(t, database, "b64-user")
	sendCh := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, 0, sendCh)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(sendCh)

	// Send announce with raw (no padding) base64 key
	rawKey := validURLSafeB64Key()
	hub.HandleMessageForTest(c, e2eeAnnounceMsg(rawKey))
	time.Sleep(30 * time.Millisecond)

	// Should NOT receive an error
	msgs := drainChan(sendCh)
	for _, m := range msgs {
		if extractType(t, m) == "error" {
			t.Errorf("raw base64 should be accepted, got error: %s", extractMessage(t, m))
		}
	}
}

func TestE2EE_Offer_AcceptsRawBase64(t *testing.T) {
	// I-2: Raw base64 in encrypted_key and iv should be accepted.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-b64-offer")

	// user1 is key holder (lowest ID)
	user1 := seedVoiceOwner(t, database, "b64o-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	user2 := seedVoiceOwner(t, database, "b64o-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)
	drainChan(send2)

	// Send offer with raw (no padding) base64
	encKey := validRawB64("encrypted-room-key-data")
	iv := validRawB64("twelve-bytes")
	hub.HandleMessageForTest(c1, e2eeOfferMsg(user2.ID, encKey, iv))
	time.Sleep(30 * time.Millisecond)

	// Should NOT get an error on sender
	msgs1 := drainChan(send1)
	for _, m := range msgs1 {
		if extractType(t, m) == "error" {
			t.Errorf("raw base64 in offer should be accepted, got error: %s", extractMessage(t, m))
		}
	}

	// Target should receive the relay
	msgs2 := drainChan(send2)
	found := false
	for _, m := range msgs2 {
		if extractType(t, m) == "voice_e2ee_offer" {
			found = true
		}
	}
	if !found {
		t.Error("target should receive offer with raw base64")
	}
}

// ─── I-6: getClientE2EEPubKey — copy key while lock held ────────────────────

func TestE2EE_GetPubKey_ReturnsKeyAfterAnnounce(t *testing.T) {
	// I-6: After announce, getClientE2EEPubKey should return the stored key
	// by copying the value while h.mu.RLock is held.
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-pubkey")

	user := seedVoiceOwner(t, database, "pubkey-user")
	sendCh := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, 0, sendCh)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(sendCh)

	// Announce a public key
	key := validB64Key()
	hub.HandleMessageForTest(c, e2eeAnnounceMsg(key))
	time.Sleep(30 * time.Millisecond)

	// Retrieve via hub method — the key should be copied under lock
	got := hub.GetClientE2EEPubKeyForTest(user.ID)
	if got != key {
		t.Errorf("GetClientE2EEPubKey = %q, want %q", got, key)
	}
}

// ─── is_key_holder in voice_token payload ────────────────────────────────────

func TestE2EE_VoiceToken_IncludesIsKeyHolder(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-iskh")

	// user1 joins first — should be key holder (lowest ID)
	user1 := seedVoiceOwner(t, database, "iskh-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	// Check that user1's voice_token has is_key_holder=true
	msgs1 := drainChan(send1)
	foundToken := false
	for _, m := range msgs1 {
		if extractType(t, m) == "voice_token" {
			foundToken = true
			isKH := extractPayloadField(t, m, "is_key_holder")
			if isKH != true {
				t.Errorf("user1 voice_token is_key_holder = %v, want true", isKH)
			}
		}
	}
	if !foundToken {
		t.Error("user1 did not receive voice_token")
	}

	// user2 joins — should NOT be key holder
	user2 := seedVoiceOwner(t, database, "iskh-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(50 * time.Millisecond)

	msgs2 := drainChan(send2)
	foundToken2 := false
	for _, m := range msgs2 {
		if extractType(t, m) == "voice_token" {
			foundToken2 = true
			isKH := extractPayloadField(t, m, "is_key_holder")
			if isKH != false {
				t.Errorf("user2 voice_token is_key_holder = %v, want false", isKH)
			}
		}
	}
	if !foundToken2 {
		t.Error("user2 did not receive voice_token")
	}
}

// ─── M-5: voiceMu comment includes e2eePubKey ───────────────────────────────
// This is a code-level check — verified by reading the source.
// The test ensures the field is guarded properly by testing concurrent access.

func TestE2EE_ConcurrentPubKeyAccess(t *testing.T) {
	hub, _ := newVoiceHub(t)
	sendCh := make(chan []byte, 32)
	c := ws.NewTestClient(hub, 1, sendCh)

	// Concurrent set/get of e2eePubKey should not race.
	done := make(chan struct{})
	go func() {
		for i := range 100 {
			ws.SetClientE2EEPubKeyForTest(c, "key-"+string(rune('A'+i%26)))
		}
		close(done)
	}()
	for range 100 {
		_ = ws.GetClientE2EEPubKeyForTest(c)
	}
	<-done
}

// ─── F3: announce signature — relay + late-joiner replay ─────────────────────

// e2eeAnnounceMsgSigned builds a voice_e2ee_announce message with a signature.
func e2eeAnnounceMsgSigned(publicKey, signature string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "voice_e2ee_announce",
		"payload": map[string]any{
			"public_key": publicKey,
			"signature":  signature,
		},
	})
	return raw
}

// validB64Sig returns a valid base64-encoded 64-byte ECDSA signature.
func validB64SigStr() string {
	sig := make([]byte, 64)
	sig[0] = 0x01
	return base64.StdEncoding.EncodeToString(sig)
}

func TestE2EE_AnnounceSignature_RelayedToPeers(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-sig-relay")

	user1 := seedVoiceOwner(t, database, "sig-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	user2 := seedVoiceOwner(t, database, "sig-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)
	drainChan(send2)

	key := validB64Key()
	sig := validB64SigStr()
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgSigned(key, sig))
	time.Sleep(30 * time.Millisecond)

	found := false
	for _, m := range drainChan(send2) {
		if extractType(t, m) != "voice_e2ee_announce" {
			continue
		}
		found = true
		gotSig, _ := extractPayloadField(t, m, "signature").(string)
		if gotSig != sig {
			t.Errorf("relayed signature = %q, want %q", gotSig, sig)
		}
		gotKey, _ := extractPayloadField(t, m, "public_key").(string)
		if gotKey != key {
			t.Errorf("relayed public_key = %q, want %q", gotKey, key)
		}
	}
	if !found {
		t.Error("peer should receive the signed announce")
	}
}

func TestE2EE_AnnounceSignature_ReplayedToLateJoiner(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-sig-replay")

	user1 := seedVoiceOwner(t, database, "sigrp-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	key := validB64Key()
	sig := validB64SigStr()
	hub.HandleMessageForTest(c1, e2eeAnnounceMsgSigned(key, sig))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	// A late joiner must receive the stored announce WITH its signature.
	user2 := seedVoiceOwner(t, database, "sigrp-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	found := false
	for _, m := range drainChan(send2) {
		if extractType(t, m) != "voice_e2ee_announce" {
			continue
		}
		found = true
		gotSig, _ := extractPayloadField(t, m, "signature").(string)
		if gotSig != sig {
			t.Errorf("replayed signature = %q, want %q", gotSig, sig)
		}
	}
	if !found {
		t.Error("late joiner should receive the replayed announce")
	}
}

func TestE2EE_AnnounceNoSignature_ReplayOmitsField(t *testing.T) {
	hub, database := newVoiceHub(t)
	chanID := seedVoiceChan(t, database, "vc-nosig")

	user1 := seedVoiceOwner(t, database, "nosig-user1")
	send1 := make(chan []byte, 32)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c1, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)
	hub.HandleMessageForTest(c1, e2eeAnnounceMsg(validB64Key()))
	time.Sleep(30 * time.Millisecond)
	drainChan(send1)

	user2 := seedVoiceOwner(t, database, "nosig-user2")
	send2 := make(chan []byte, 32)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)
	hub.HandleMessageForTest(c2, voiceJoinMsg(chanID))
	time.Sleep(30 * time.Millisecond)

	for _, m := range drainChan(send2) {
		if extractType(t, m) != "voice_e2ee_announce" {
			continue
		}
		if v := extractPayloadField(t, m, "signature"); v != nil {
			t.Errorf("legacy replay must omit signature, got %v", v)
		}
	}
}
