package ws

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

// validB64Key is a valid base64-encoded P-256 public key (65 bytes uncompressed).
var validB64Key = base64.StdEncoding.EncodeToString(make([]byte, 65))

func TestVoiceE2EEAnnounceV2_HappyPath(t *testing.T) {
	deps := VoiceDeps{}
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: validB64Key}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}

	// Should set the E2EE public key on the client via Result.
	if result.SetE2EEPubKey == nil {
		t.Fatal("expected SetE2EEPubKey to be set")
	}
	if *result.SetE2EEPubKey != validB64Key {
		t.Errorf("expected SetE2EEPubKey %q, got %q", validB64Key, *result.SetE2EEPubKey)
	}

	// Should emit a VoiceE2EEAnnounceEvent to the voice channel.
	if len(result.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(result.Events))
	}
	evt, ok := result.Events[0].(VoiceChannelEvent)
	if !ok {
		t.Fatalf("expected VoiceChannelEvent, got %T", result.Events[0])
	}
	if evt.VoiceChannelID() != 100 {
		t.Errorf("expected voice channel 100, got %d", evt.VoiceChannelID())
	}
	if evt.ExcludeUserID() != 1 {
		t.Errorf("expected exclude user 1, got %d", evt.ExcludeUserID())
	}
}

func TestVoiceE2EEAnnounceV2_NotInVoiceChannel(t *testing.T) {
	deps := VoiceDeps{}
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: validB64Key}
	info := ClientInfo{UserID: 1, VoiceChannelID: 0}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for not in voice channel")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeVoiceError {
		t.Errorf("expected code %q, got %q", ErrCodeVoiceError, ce.Code)
	}
}

func TestVoiceE2EEAnnounceV2_EmptyPublicKey(t *testing.T) {
	deps := VoiceDeps{}
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: ""}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for empty public_key")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadPayload {
		t.Errorf("expected code %q, got %q", ErrCodeBadPayload, ce.Code)
	}
}

func TestVoiceE2EEAnnounceV2_PublicKeyTooLarge(t *testing.T) {
	deps := VoiceDeps{}
	largeKey := strings.Repeat("A", 129)
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: largeKey}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for oversized public_key")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadPayload {
		t.Errorf("expected code %q, got %q", ErrCodeBadPayload, ce.Code)
	}
}

func TestVoiceE2EEAnnounceV2_InvalidBase64(t *testing.T) {
	deps := VoiceDeps{}
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: "not-valid-base64!!!"}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for invalid base64")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadPayload {
		t.Errorf("expected code %q, got %q", ErrCodeBadPayload, ce.Code)
	}
}

func TestVoiceE2EEAnnounceV2_NoReply(t *testing.T) {
	deps := VoiceDeps{}
	cmd := VoiceE2EEAnnounceCmd{userID: 1, publicKey: validB64Key}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEAnnounceV2(context.Background(), cmd, info, deps)

	if result.Reply != nil {
		t.Errorf("expected no reply, got %s", result.Reply)
	}
}
