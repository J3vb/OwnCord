package ws

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
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

// tokenRefreshDeps wires a real in-memory DB because the handler now re-checks
// CONNECT_VOICE before minting a token: user 1 holds a voice-only role (READ +
// CONNECT_VOICE, no SPEAK/VIDEO/SCREEN_SHARE) on voice channel 100. The handle
// is returned alongside the deps for the one case that re-seeds the role
// mid-test — VoiceDeps itself no longer carries it (B3-8 voice family).
func tokenRefreshDeps(t *testing.T) (VoiceDeps, *db.DB) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if migErr := db.Migrate(database); migErr != nil {
		t.Fatalf("Migrate: %v", migErr)
	}
	t.Cleanup(func() { _ = database.Close() })

	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages|permissions.ConnectVoice)
	seedTokenRefreshUser(t, database, 1, voiceOnlyRoleID)
	if _, execErr := database.ExecContext(context.Background(),
		`INSERT INTO channels (id, name, type, position) VALUES (100, 'voice-100', 'voice', 0)`,
	); execErr != nil {
		t.Fatalf("seed channel: %v", execErr)
	}

	return VoiceDeps{
		Voice:       service.NewVoiceService(database),
		Reader:      database,
		Permissions: permissions.NewChecker(database),
		Limiter:     auth.NewRateLimiter(),
		TokenGen:    &mockTokenGen{token: "jwt-test-token", url: "ws://lk:7880"},
		KeyHolder:   &mockKeyHolder{isHolder: true},
	}, database
}

// voiceOnlyRoleID is a fixed id well clear of the migration-seeded defaults.
const voiceOnlyRoleID = 900

func seedVoiceOnlyRole(t *testing.T, database *db.DB, roleID, perms int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, permissions, position, is_default)
		 VALUES (?, 'voice-only', ?, 5, 0)
		 ON CONFLICT(id) DO UPDATE SET permissions = excluded.permissions`,
		roleID, perms,
	); err != nil {
		t.Fatalf("seed role: %v", err)
	}
}

func seedTokenRefreshUser(t *testing.T, database *db.DB, userID, roleID int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password, role_id) VALUES (?, 'alice', '', ?)
		 ON CONFLICT(id) DO UPDATE SET role_id = excluded.role_id`,
		userID, roleID,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
}

func TestVoiceTokenRefreshV2_HappyPath(t *testing.T) {
	deps, _ := tokenRefreshDeps(t)
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
	deps, _ := tokenRefreshDeps(t)
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, VoiceChannelID: 0}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for not in voice")
	}
	var ce ClientError
	ok := errors.As(result.Error, &ce)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeBadRequest {
		t.Errorf("expected code %q, got %q", ErrCodeBadRequest, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_RateLimited(t *testing.T) {
	deps, _ := tokenRefreshDeps(t)
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	// Exhaust the rate limit (1 per 60s).
	_ = handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected rate limit error")
	}
	var ce ClientError
	ok := errors.As(result.Error, &ce)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeRateLimited {
		t.Errorf("expected code %q, got %q", ErrCodeRateLimited, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_TokenGenNil(t *testing.T) {
	deps, _ := tokenRefreshDeps(t)
	deps.TokenGen = nil
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error for nil TokenGen")
	}
	var ce ClientError
	ok := errors.As(result.Error, &ce)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected code %q, got %q", ErrCodeInternal, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_GenerateTokenError(t *testing.T) {
	deps, _ := tokenRefreshDeps(t)
	deps.TokenGen = &mockTokenGen{err: context.DeadlineExceeded, url: "ws://lk:7880"}
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if result.Error == nil {
		t.Fatal("expected error from GenerateToken failure")
	}
	var ce ClientError
	ok := errors.As(result.Error, &ce)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeInternal {
		t.Errorf("expected code %q, got %q", ErrCodeInternal, ce.Code)
	}
}

func TestVoiceTokenRefreshV2_IsKeyHolderReflectedInReply(t *testing.T) {
	deps, _ := tokenRefreshDeps(t)
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
	deps, _ := tokenRefreshDeps(t)
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)

	if len(result.Events) != 0 {
		t.Errorf("expected no events, got %d", len(result.Events))
	}
}

func TestVoiceTokenRefreshV2_PermissionsPassedToTokenGen(t *testing.T) {
	// Use a capturing mock to verify permissions are forwarded. The fixture role
	// holds CONNECT_VOICE (so the token is minted at all) but none of
	// SPEAK_VOICE / USE_VIDEO / SHARE_SCREEN, so each publish grant must be
	// false while subscribe stays unconditionally true.
	captureMock := &capturingTokenGen{token: "jwt", url: "ws://lk"}
	deps, _ := tokenRefreshDeps(t)
	deps.TokenGen = captureMock

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

// TestVoiceTokenRefreshV2_RevokedConnectVoiceRefusedAndEvicts locks the
// revocation invariant: voice_join was the only place CONNECT_VOICE was ever
// checked, so a user stripped of it mid-session could keep re-minting LiveKit
// room-join grants (one per 60s, CanSubscribe=true) for a channel they are no
// longer allowed in. The refusal must also evict, or the live SFU session
// simply outlives the permission.
func TestVoiceTokenRefreshV2_RevokedConnectVoiceRefusedAndEvicts(t *testing.T) {
	deps, database := tokenRefreshDeps(t)
	cmd := VoiceTokenRefreshCmd{userID: 1}
	info := ClientInfo{UserID: 1, Username: "alice", VoiceChannelID: 100, VoiceJoinToken: "t"}

	// Still authorized: a token is issued.
	if result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps); result.Error != nil {
		t.Fatalf("authorized refresh must succeed: %v", result.Error)
	}

	// A moderator strips CONNECT_VOICE from the role.
	seedVoiceOnlyRole(t, database, voiceOnlyRoleID, permissions.ReadMessages)
	deps.Limiter = auth.NewRateLimiter() // clear the 1-per-60s budget for this second call

	result := handleVoiceTokenRefreshV2(context.Background(), cmd, info, deps)
	if result.Error == nil {
		t.Fatal("revoked CONNECT_VOICE must not mint a fresh SFU token")
	}
	var ce ClientError
	ok := errors.As(result.Error, &ce)
	if !ok {
		t.Fatalf("expected ClientError, got %T", result.Error)
	}
	if ce.Code != ErrCodeForbidden {
		t.Errorf("expected code %q, got %q", ErrCodeForbidden, ce.Code)
	}
	if result.Reply != nil {
		t.Error("no voice token may accompany the refusal")
	}
	if !result.LeaveVoice {
		t.Error("refusal must also evict the live voice session")
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
