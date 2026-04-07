package ws

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/owncord/server/auth"
)

// ── mocks ──────────────────────────────────────────────────────────────────────

type mockTokenGen struct {
	token string
	err   error
	url   string
}

func (m *mockTokenGen) GenerateToken(
	_ int64, _ string, _ int64, _ string,
	_, _, _, _ bool,
) (string, error) {
	return m.token, m.err
}

func (m *mockTokenGen) URL() string { return m.url }

type mockKeyHolder struct {
	isHolder bool
}

func (m *mockKeyHolder) IsVoiceKeyHolder(_, _ int64) bool { return m.isHolder }

// ── tests ──────────────────────────────────────────────────────────────────────

func tokenRefreshDeps() VoiceDeps {
	return VoiceDeps{
		Limiter:   auth.NewRateLimiter(),
		TokenGen:  &mockTokenGen{token: "jwt-test-token", url: "ws://lk:7880"},
		KeyHolder: &mockKeyHolder{isHolder: true},
	}
}

func TestVoiceTokenRefreshV2_HappyPath(t *testing.T) {
	deps := tokenRefreshDeps()
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{
		UserID:         1,
		Username:       "alice",
		VoiceChannelID: 100,
		VoiceJoinToken: "join-tok-123",
	}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	if result.Reply == nil {
		t.Fatal("expected a reply with voice token")
	}

	var reply map[string]any
	if err := json.Unmarshal(result.Reply, &reply); err != nil {
		t.Fatalf("failed to unmarshal reply: %v", err)
	}
	if reply["type"] != MsgTypeVoiceToken {
		t.Errorf("expected type %q, got %q", MsgTypeVoiceToken, reply["type"])
	}
}

func TestVoiceTokenRefreshV2_NotInVoice(t *testing.T) {
	deps := tokenRefreshDeps()
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, VoiceChannelID: 0}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for not in voice")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadRequest {
		t.Errorf("expected code %q, got %q", ErrCodeBadRequest, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_RateLimited(t *testing.T) {
	deps := tokenRefreshDeps()
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	// Exhaust the rate limit (1 per 60s).
	_ = handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected rate limit error")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeRateLimited {
		t.Errorf("expected code %q, got %q", ErrCodeRateLimited, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_TokenGenNil(t *testing.T) {
	deps := tokenRefreshDeps()
	deps.TokenGen = nil
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for nil TokenGen")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected code %q, got %q", ErrCodeInternal, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_GenerateTokenError(t *testing.T) {
	deps := tokenRefreshDeps()
	deps.TokenGen = &mockTokenGen{err: context.DeadlineExceeded, url: "ws://lk:7880"}
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error from GenerateToken failure")
	}
	ce, ok := result.Error.(ClientError)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected code %q, got %q", ErrCodeInternal, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_IsKeyHolderReflectedInReply(t *testing.T) {
	deps := tokenRefreshDeps()
	deps.KeyHolder = &mockKeyHolder{isHolder: false}
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	var reply struct {
		Payload struct {
			IsKeyHolder bool `json:"is_key_holder"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(result.Reply, &reply); err != nil {
		t.Fatalf("failed to unmarshal reply: %v", err)
	}
	if reply.Payload.IsKeyHolder != false {
		t.Error("expected is_key_holder=false in reply")
	}
}

func TestVoiceTokenRefreshV2_NoEvents(t *testing.T) {
	deps := tokenRefreshDeps()
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}

func TestVoiceTokenRefreshV2_PermissionsPassedToTokenGen(t *testing.T) {
	// Use a capturing mock to verify permissions are forwarded.
	captureMock := &capturingTokenGen{token: "jwt", url: "ws://lk"}
	deps := tokenRefreshDeps()
	deps.TokenGen = captureMock
	// No Permissions or DB set → hasPerm returns false for all.
	deps.Permissions = nil
	deps.DB = nil

	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error != nil {
		t.Fatalf("unexpected error: %v", result.Error)
	}
	// Without permissions/DB, all permission checks return false.
	if captureMock.canPublish {
		t.Error("expected canPublish=false without permissions")
	}
	if captureMock.canVideo {
		t.Error("expected canVideo=false without permissions")
	}
	if captureMock.canScreenShare {
		t.Error("expected canScreenShare=false without permissions")
	}
	// canSubscribe should always be true.
	if !captureMock.canSubscribe {
		t.Error("expected canSubscribe=true always")
	}
}

// capturingTokenGen records the arguments passed to GenerateToken.
type capturingTokenGen struct {
	token          string
	url            string
	canPublish     bool
	canSubscribe   bool
	canVideo       bool
	canScreenShare bool
}

func (m *capturingTokenGen) GenerateToken(
	_ int64, _ string, _ int64, _ string,
	canPublish, canSubscribe, canVideo, canScreenShare bool,
) (string, error) {
	m.canPublish = canPublish
	m.canSubscribe = canSubscribe
	m.canVideo = canVideo
	m.canScreenShare = canScreenShare
	return m.token, nil
}

func (m *capturingTokenGen) URL() string { return m.url }
