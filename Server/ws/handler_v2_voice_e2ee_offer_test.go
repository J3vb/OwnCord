package ws

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/owncord/server/auth"
)

var (
	validEncKey = base64.StdEncoding.EncodeToString(make([]byte, 48))
	validIV     = base64.StdEncoding.EncodeToString(make([]byte, 12))
)

func offerDeps(isHolder bool) VoiceDeps {
	return VoiceDeps{
		KeyHolder: &mockKeyHolder{isHolder: isHolder},
	}
}

func TestVoiceE2EEOfferV2_HappyPath(t *testing.T) {
	deps := offerDeps(true)
	cmd := VoiceE2EEOfferCmd{
		userID:       1,
		targetUserID: 2,
		encryptedKey: validEncKey,
		iv:           validIV,
	}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if len(result.Events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(result.Events))
	}

	// Should be a VoiceChannelGuardedEvent targeting user 2.
	evt, ok := result.Events[0].(VoiceChannelGuardedEvent)
	if !ok {
		t.Fatalf("expected VoiceChannelGuardedEvent, got %T", result.Events[0])
	}
	if evt.TargetUserID() != 2 {
		t.Errorf("expected target user 2, got %d", evt.TargetUserID())
	}
	if evt.VoiceChannelID() != 100 {
		t.Errorf("expected voice channel 100, got %d", evt.VoiceChannelID())
	}
}

// TestVoiceE2EEOfferV2_RotationBurstNotRateLimited locks the W1-2 fix: the
// key holder rotates by sending one offer per peer back-to-back, so the
// limiter is keyed per (sender, target) and must admit an entire rotation
// burst in a large call — while repeated offers at one victim stay capped.
func TestVoiceE2EEOfferV2_RotationBurstNotRateLimited(t *testing.T) {
	deps := offerDeps(true)
	deps.Limiter = auth.NewRateLimiter()
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	// 8-participant call: one offer to each of 7 peers, immediately.
	for target := int64(2); target <= 8; target++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: target, encryptedKey: validEncKey, iv: validIV}
		if result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps); result.Error != nil {
			t.Fatalf("rotation offer to peer %d rejected: %v", target, result.Error)
		}
	}

	// Join/leave churn triggers back-to-back rotations — a second full burst
	// must also pass.
	for target := int64(2); target <= 8; target++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: target, encryptedKey: validEncKey, iv: validIV}
		if result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps); result.Error != nil {
			t.Fatalf("second rotation offer to peer %d rejected: %v", target, result.Error)
		}
	}

	// Spamming a single victim is still limited: 2 offers spent above, the
	// per-target budget is 5/sec, so within 4 more attempts one must trip.
	var limited bool
	for i := 0; i < 4; i++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: validIV}
		if result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps); result.Error != nil {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("same-target offer spam must still hit the rate limit")
	}
}

// TestVoiceE2EEOfferV2_RejectedOffersAllocateNoLimiterState locks the fix for
// the unbounded-map defect: the limiter key interpolated the client-supplied
// target_user_id and ran before every validation, so one authenticated socket —
// not in voice, not a key holder — could insert a fresh entry into the shared
// process-wide RateLimiter on every frame. Entries live ~20 minutes, so the
// spray was a memory-exhaustion lever against the whole server.
func TestVoiceE2EEOfferV2_RejectedOffersAllocateNoLimiterState(t *testing.T) {
	limiter := auth.NewRateLimiter()

	// (a) Not in a voice channel at all — the cheapest rejection.
	deps := offerDeps(false)
	deps.Limiter = limiter
	info := ClientInfo{UserID: 1, VoiceChannelID: 0}
	for target := int64(1); target <= 500; target++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: target, encryptedKey: validEncKey, iv: validIV}
		if result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps); result.Error == nil {
			t.Fatalf("offer from a client not in voice must be rejected (target %d)", target)
		}
	}
	if windows, _ := limiter.Len(); windows != 0 {
		t.Fatalf("a client not in voice allocated %d limiter entries, want 0", windows)
	}

	// (b) In voice but not the key holder — rejected later, still allocates nothing.
	info = ClientInfo{UserID: 1, VoiceChannelID: 100}
	for target := int64(1); target <= 500; target++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: target, encryptedKey: validEncKey, iv: validIV}
		if result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps); result.Error == nil {
			t.Fatalf("offer from a non-key-holder must be rejected (target %d)", target)
		}
	}
	if windows, _ := limiter.Len(); windows != 0 {
		t.Fatalf("a non-key-holder allocated %d limiter entries, want 0", windows)
	}

	// (c) A real key holder is still budgeted, and its entries are bounded by
	// the channel-keyed outer budget rather than by attacker-chosen target ids.
	holderDeps := offerDeps(true)
	holderDeps.Limiter = limiter
	for target := int64(1); target <= 500; target++ {
		cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: target, encryptedKey: validEncKey, iv: validIV}
		handleVoiceE2EEOfferV2(context.Background(), cmd, info, holderDeps)
	}
	windows, _ := limiter.Len()
	if windows > voiceE2EEOfferRateLimit+1 {
		t.Fatalf("key holder spraying 500 target ids allocated %d limiter entries, want at most %d",
			windows, voiceE2EEOfferRateLimit+1)
	}
}

func TestVoiceE2EEOfferV2_NotInVoiceChannel(t *testing.T) {
	deps := offerDeps(true)
	cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: validIV}
	info := ClientInfo{UserID: 1, VoiceChannelID: 0}

	result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps)

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

func TestVoiceE2EEOfferV2_EmptyFields(t *testing.T) {
	deps := offerDeps(true)
	tests := []struct {
		name string
		cmd  VoiceE2EEOfferCmd
	}{
		{"empty target", VoiceE2EEOfferCmd{userID: 1, targetUserID: 0, encryptedKey: validEncKey, iv: validIV}},
		{"empty key", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: "", iv: validIV}},
		{"empty iv", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: ""}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ClientInfo{UserID: 1, VoiceChannelID: 100}
			result := handleVoiceE2EEOfferV2(context.Background(), tt.cmd, info, deps)
			if result.Error == nil {
				t.Fatal("expected error for empty field")
			}
			ce, ok := result.Error.(ClientError)
			if !ok {
				t.Fatalf("expected ClientError, got %T", result.Error)
			}
			if ce.Code != ErrCodeBadPayload {
				t.Errorf("expected code %q, got %q", ErrCodeBadPayload, ce.Code)
			}
		})
	}
}

func TestVoiceE2EEOfferV2_OversizedFields(t *testing.T) {
	deps := offerDeps(true)
	tests := []struct {
		name string
		cmd  VoiceE2EEOfferCmd
	}{
		{"key too large", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: strings.Repeat("A", 1025), iv: validIV}},
		{"iv too large", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: strings.Repeat("A", 129)}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ClientInfo{UserID: 1, VoiceChannelID: 100}
			result := handleVoiceE2EEOfferV2(context.Background(), tt.cmd, info, deps)
			if result.Error == nil {
				t.Fatal("expected error for oversized field")
			}
			ce, ok := result.Error.(ClientError)
			if !ok {
				t.Fatalf("expected ClientError, got %T", result.Error)
			}
			if ce.Code != ErrCodeBadPayload {
				t.Errorf("expected code %q, got %q", ErrCodeBadPayload, ce.Code)
			}
		})
	}
}

func TestVoiceE2EEOfferV2_InvalidBase64(t *testing.T) {
	deps := offerDeps(true)
	tests := []struct {
		name string
		cmd  VoiceE2EEOfferCmd
	}{
		{"bad key", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: "not-base64!!!", iv: validIV}},
		{"bad iv", VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: "not-base64!!!"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ClientInfo{UserID: 1, VoiceChannelID: 100}
			result := handleVoiceE2EEOfferV2(context.Background(), tt.cmd, info, deps)
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
		})
	}
}

func TestVoiceE2EEOfferV2_NotKeyHolder(t *testing.T) {
	deps := offerDeps(false)
	cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: validIV}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for non-key-holder")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeNotKeyHolder {
		t.Errorf("expected code %q, got %q", ErrCodeNotKeyHolder, ce.Code)
	}
}

func TestVoiceE2EEOfferV2_NilKeyHolder_ReturnsInternal(t *testing.T) {
	deps := VoiceDeps{KeyHolder: nil}
	cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: validIV}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for nil KeyHolder")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected code %q, got %q", ErrCodeInternal, ce.Code)
	}
}

func TestVoiceE2EEOfferV2_NoReply(t *testing.T) {
	deps := offerDeps(true)
	cmd := VoiceE2EEOfferCmd{userID: 1, targetUserID: 2, encryptedKey: validEncKey, iv: validIV}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100}

	result := handleVoiceE2EEOfferV2(context.Background(), cmd, info, deps)

	if result.Reply != nil {
		t.Errorf("expected no reply, got %s", result.Reply)
	}
}
