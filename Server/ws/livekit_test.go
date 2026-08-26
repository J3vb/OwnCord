package ws_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
)

// ---------------------------------------------------------------------------
// livekit.go tests
// ---------------------------------------------------------------------------

func TestWsToHTTP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{"ws to http", "ws://localhost:7880", "http://localhost:7880"},
		{"wss to https", "wss://livekit.example.com", "https://livekit.example.com"},
		{"http passthrough", "http://localhost:7880", "http://localhost:7880"},
		{"https passthrough", "https://livekit.example.com", "https://livekit.example.com"},
		{"empty string", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got := ws.WsToHTTPForTest(tt.in)
			if got != tt.want {
				t.Errorf("wsToHTTP(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestRoomName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		channelID int64
		want      string
	}{
		{1, "channel-1"},
		{42, "channel-42"},
		{0, "channel-0"},
		{999999, "channel-999999"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			t.Parallel()
			got := ws.RoomName(tt.channelID)
			if got != tt.want {
				t.Errorf("RoomName(%d) = %q, want %q", tt.channelID, got, tt.want)
			}
		})
	}
}

func TestNewLiveKitClient_MissingConfig(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		cfg  config.VoiceConfig
	}{
		{
			"empty api key",
			config.VoiceConfig{
				LiveKitAPIKey:    "",
				LiveKitAPISecret: "some-secret",
				LiveKitURL:       "ws://localhost:7880",
			},
		},
		{
			"empty api secret",
			config.VoiceConfig{
				LiveKitAPIKey:    "some-key",
				LiveKitAPISecret: "",
				LiveKitURL:       "ws://localhost:7880",
			},
		},
		{
			"empty url",
			config.VoiceConfig{
				LiveKitAPIKey:    "some-key",
				LiveKitAPISecret: "some-secret",
				LiveKitURL:       "",
			},
		},
		{
			"all empty",
			config.VoiceConfig{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			client, err := ws.NewLiveKitClient(&tt.cfg)
			if err == nil {
				t.Fatal("expected error for missing config, got nil")
			}
			if client != nil {
				t.Fatal("expected nil client on error")
			}
		})
	}
}

func TestGenerateToken_ValidToken(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret-that-is-long-enough-for-hmac",
		LiveKitURL:       "ws://localhost:7880",
	}

	client, err := ws.NewLiveKitClient(cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	token, err := client.GenerateToken(123, "testuser", 456, "join-token-1", true, true, true, true)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty JWT token")
	}

	// JWT tokens have three dot-separated parts.
	parts := 0
	for _, b := range token {
		if b == '.' {
			parts++
		}
	}
	if parts != 2 {
		t.Errorf("expected JWT with 2 dots (3 parts), got %d dots in %q", parts, token)
	}
}

func TestGenerateToken_DifferentPermissions(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret-that-is-long-enough-for-hmac",
		LiveKitURL:       "ws://localhost:7880",
	}

	client, err := ws.NewLiveKitClient(cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	// Subscribe-only token (canPublish=false).
	token, err := client.GenerateToken(1, "listener", 10, "join-token-2", false, true, false, false)
	if err != nil {
		t.Fatalf("GenerateToken(subscribe-only): %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty token for subscribe-only")
	}
}

// TestGenerateToken_VideoAndScreenShareGrantedWithoutSpeakVoice locks OC-0016:
// SPEAK_VOICE, USE_VIDEO and SHARE_SCREEN are independent permission bits
// (EffectiveChannelPerms resolves each per-bit), so a channel override can
// deny SPEAK_VOICE while still granting USE_VIDEO/SHARE_SCREEN — e.g. a
// presentation channel where only video is wanted. handleVoiceCameraV2 and
// handleVoiceScreenshareV2 gate only on USE_VIDEO/SHARE_SCREEN respectively,
// so the LiveKit token must carry a matching per-source grant instead of a
// blanket CanPublish=false that blocks every source, camera and screen share
// included, once SPEAK_VOICE is denied.
func TestGenerateToken_VideoAndScreenShareGrantedWithoutSpeakVoice(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "test-key",
		LiveKitAPISecret: "test-secret-that-is-long-enough-for-hmac",
		LiveKitURL:       "ws://localhost:7880",
	}

	client, err := ws.NewLiveKitClient(cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}

	// canPublish=false (SPEAK_VOICE denied), canVideo=true, canScreenShare=true.
	token, err := client.GenerateToken(1, "presenter", 10, "join-token-3", false, true, true, true)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatalf("ParseAPIToken: %v", err)
	}
	_, grants, err := verifier.Verify(cfg.LiveKitAPISecret)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if grants.Video == nil {
		t.Fatal("expected a video grant in the token")
	}

	if !grants.Video.GetCanPublishSource(livekit.TrackSource_CAMERA) {
		t.Error("expected camera to be publishable when USE_VIDEO is granted, even though SPEAK_VOICE is denied")
	}
	if !grants.Video.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE) {
		t.Error("expected screen_share to be publishable when SHARE_SCREEN is granted, even though SPEAK_VOICE is denied")
	}
	if !grants.Video.GetCanPublishSource(livekit.TrackSource_SCREEN_SHARE_AUDIO) {
		t.Error("expected screen_share_audio to be publishable when SHARE_SCREEN is granted, even though SPEAK_VOICE is denied")
	}
	if grants.Video.GetCanPublishSource(livekit.TrackSource_MICROPHONE) {
		t.Error("expected microphone NOT to be publishable when SPEAK_VOICE is denied")
	}
}

// ---------------------------------------------------------------------------
// livekit_process.go tests
// ---------------------------------------------------------------------------

func TestNewLiveKitProcess(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())
	if proc == nil {
		t.Fatal("expected non-nil LiveKitProcess")
	}
}

func TestLiveKitProcess_Start_NoBinary(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "", // empty → no-op
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	err := proc.Start()
	if err != nil {
		t.Fatalf("Start() with empty binary should return nil, got: %v", err)
	}
}

func TestLiveKitProcess_IsRunning_Default(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false before Start()")
	}
}

func TestLiveKitProcess_Stop_BeforeStart(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	// Stop() before Start() should not panic.
	proc.Stop()

	// After Stop(), IsRunning should still be false.
	if proc.IsRunning() {
		t.Fatal("expected IsRunning() = false after Stop() without Start()")
	}
}

// ---------------------------------------------------------------------------
// livekit_webhook.go tests
// ---------------------------------------------------------------------------

func TestParseIdentity_Valid(t *testing.T) {
	t.Parallel()

	id, err := ws.ParseIdentityForTest("user-123")
	if err != nil {
		t.Fatalf("parseIdentity(\"user-123\"): unexpected error: %v", err)
	}
	if id != 123 {
		t.Errorf("parseIdentity(\"user-123\") = %d, want 123", id)
	}
}

func TestParseParticipantIdentity_WithJoinToken(t *testing.T) {
	t.Parallel()

	userID, joinToken, err := ws.ParseParticipantIdentityForTest("user-123:join-token-42")
	if err != nil {
		t.Fatalf("parseParticipantIdentity: unexpected error: %v", err)
	}
	if userID != 123 {
		t.Fatalf("userID = %d, want 123", userID)
	}
	if joinToken != "join-token-42" {
		t.Fatalf("joinToken = %q, want join-token-42", joinToken)
	}
}

func TestParseIdentity_Invalid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
	}{
		{"no prefix", "invalid"},
		{"empty id", "user-"},
		{"non-numeric", "user-abc"},
		{"wrong prefix", "admin-123"},
		{"empty string", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ws.ParseIdentityForTest(tt.input)
			if err == nil {
				t.Errorf("parseIdentity(%q): expected error, got nil", tt.input)
			}
		})
	}
}

func TestParseRoomChannelID_Valid(t *testing.T) {
	t.Parallel()

	id, err := ws.ParseRoomChannelIDForTest("channel-456")
	if err != nil {
		t.Fatalf("parseRoomChannelID(\"channel-456\"): unexpected error: %v", err)
	}
	if id != 456 {
		t.Errorf("parseRoomChannelID(\"channel-456\") = %d, want 456", id)
	}
}

func TestParseRoomChannelID_Invalid(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input string
	}{
		{"no prefix", "invalid"},
		{"non-numeric", "channel-abc"},
		{"wrong prefix", "room-123"},
		{"empty string", ""},
		{"empty id", "channel-"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := ws.ParseRoomChannelIDForTest(tt.input)
			if err == nil {
				t.Errorf("parseRoomChannelID(%q): expected error, got nil", tt.input)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Webhook idempotency regression tests
// ---------------------------------------------------------------------------

// countVoiceLeaves drains the send channel and returns how many voice_leave
// messages it contained within the timeout.
func countVoiceLeaves(ch <-chan []byte, timeout time.Duration) int {
	count := 0
	deadline := time.After(timeout)
	for {
		select {
		case msg := <-ch:
			var parsed struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(msg, &parsed) == nil && parsed.Type == "voice_leave" {
				count++
			}
		case <-deadline:
			return count
		}
	}
}

// TestWebhook_ParticipantLeft_NoDoubleBroadcast_AfterFreshCleanup proves that
// after serve.go's fresh-reconnect cleanup clears the old client's voice state,
// a subsequent participant_left webhook with the same join token does NOT
// broadcast a second voice_leave.
func TestWebhook_ParticipantLeft_NoDoubleBroadcast_AfterFreshCleanup(t *testing.T) {
	t.Parallel()
	hub, database := newVoiceHub(t)

	user := seedVoiceOwner(t, database, "webhook-idem-user")
	chanID := seedVoiceChannel(t, database, "webhook-idem-ch")

	// Observer client to capture broadcasts.
	observerSend := make(chan []byte, 64)
	observer := ws.NewTestClient(hub, 99999, observerSend)
	hub.RegisterNowForTest(observer)

	// Insert the matching DB row first so the simulated client carries the
	// same join token production would have persisted and handed to LiveKit.
	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, vs == nil)
	}

	// Simulate the old client being in voice with the persisted join token.
	oldSend := make(chan []byte, 64)
	oldClient := ws.NewTestClient(hub, user.ID, oldSend)
	ws.SetClientVoiceStateForTest(oldClient, chanID, vs.JoinedAt)
	hub.RegisterNowForTest(oldClient)

	// --- Simulate what serve.go fresh-cleanup does (lines 150-172) ---
	// 1. Delete the DB row.
	deleted, err := database.LeaveVoiceChannelIfMatch(context.Background(), user.ID, chanID, vs.JoinedAt)
	if err != nil || !deleted {
		t.Fatalf("LeaveVoiceChannelIfMatch: err=%v deleted=%v", err, deleted)
	}

	// 2. Clear old client's in-memory voice state (the fix in serve.go).
	oldClient.ClearVoiceStateForTest()

	// 3. Broadcast voice_leave (serve.go does this).
	hub.BroadcastToAll(ws.BuildJSONForTest(map[string]any{
		"type":    "voice_leave",
		"payload": map[string]any{"channel_id": chanID, "user_id": user.ID},
	}))

	// Give broadcast a moment to propagate.
	time.Sleep(20 * time.Millisecond)

	// Drain the first voice_leave from the observer.
	first := countVoiceLeaves(observerSend, 50*time.Millisecond)
	if first != 1 {
		t.Fatalf("expected 1 initial voice_leave broadcast, got %d", first)
	}

	// --- Now simulate the webhook arriving for the same join token ---
	hub.HandleWebhookParticipantLeftForTest(user.ID, chanID, vs.JoinedAt)

	// The webhook should NOT produce a second voice_leave because:
	// - The old client's in-memory voice state was cleared (token-match branch is a no-op).
	// - The DB row was already deleted (else branch's LeaveVoiceChannelIfMatch returns deleted=false).
	second := countVoiceLeaves(observerSend, 100*time.Millisecond)
	if second != 0 {
		t.Errorf("expected 0 additional voice_leave broadcasts after webhook, got %d", second)
	}
}

// TestWebhook_ParticipantLeft_OldToken_DoesNotTeardownReplacement proves that
// a participant_left webhook carrying an old join token does NOT tear down a
// replacement voice session that has a different join token.
func TestWebhook_ParticipantLeft_OldToken_DoesNotTeardownReplacement(t *testing.T) {
	t.Parallel()
	hub, database := newVoiceHub(t)

	user := seedVoiceOwner(t, database, "webhook-old-token-user")
	chanID := seedVoiceChannel(t, database, "webhook-old-token-ch")

	// Observer to capture broadcasts.
	observerSend := make(chan []byte, 64)
	observer := ws.NewTestClient(hub, 88888, observerSend)
	hub.RegisterNowForTest(observer)

	// Create an old same-channel voice session, then rejoin the same channel so
	// the DB carries a replacement join token like production would.
	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel(old): %v", err)
	}
	oldState, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || oldState == nil {
		t.Fatalf("GetVoiceState(old): %v (nil=%v)", err, oldState == nil)
	}

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel(new): %v", err)
	}
	newState, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || newState == nil {
		t.Fatalf("GetVoiceState(new): %v (nil=%v)", err, newState == nil)
	}
	if newState.JoinedAt == oldState.JoinedAt {
		t.Fatalf("same-channel rejoin reused join token %q", newState.JoinedAt)
	}

	// The replacement client carries the current persisted join token.
	newSend := make(chan []byte, 64)
	newClient := ws.NewTestClient(hub, user.ID, newSend)
	ws.SetClientVoiceStateForTest(newClient, chanID, newState.JoinedAt)
	hub.RegisterNowForTest(newClient)

	// --- Webhook arrives with the OLD join token ---
	hub.HandleWebhookParticipantLeftForTest(user.ID, chanID, oldState.JoinedAt)

	// The webhook should NOT broadcast voice_leave because:
	// - Token-match branch: currentJoinToken != old join token -> skipped.
	// - Else branch: LeaveVoiceChannelIfMatch with the old token won't match the new DB row → deleted=false.
	leaves := countVoiceLeaves(observerSend, 100*time.Millisecond)
	if leaves != 0 {
		t.Errorf("expected 0 voice_leave broadcasts for old-token webhook, got %d", leaves)
	}

	// The new client's voice state should be untouched.
	if got := ws.GetClientVoiceChIDForTest(newClient); got != chanID {
		t.Errorf("new client voiceChID = %d, want %d (should be untouched)", got, chanID)
	}
	if got := ws.GetClientVoiceJoinTokenForTest(newClient); got != newState.JoinedAt {
		t.Errorf("new client voiceJoinToken = %q, want %q", got, newState.JoinedAt)
	}

	// DB row should still exist.
	vs, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState: %v", err)
	}
	if vs == nil {
		t.Fatal("replacement voice state was deleted by old-token webhook — should have been preserved")
	}
	if vs.JoinedAt != newState.JoinedAt {
		t.Fatalf("replacement join token = %q, want %q", vs.JoinedAt, newState.JoinedAt)
	}
}

// TestWebhook_ParticipantLeft_ClearsE2EEState_OnMatch locks a correctness
// detail of the v050 fix: handleWebhookParticipantLeft now clears the
// client's voice state via an atomic compare-and-clear (both channel and
// join token checked under voiceMu in one critical section) instead of two
// independent unlocked reads followed by an unconditional clear. This test
// pins the matching-case behavior of the rewrite: it must still clear
// e2eePubKey/e2eeSignature exactly like the old clearVoiceState-based path
// did, not just voiceChID/voiceJoinToken — otherwise a departed
// participant's stale ECDH key lingers on the connection and pollutes a
// later voice session's peer-key store.
func TestWebhook_ParticipantLeft_ClearsE2EEState_OnMatch(t *testing.T) {
	t.Parallel()
	hub, database := newVoiceHub(t)

	user := seedVoiceOwner(t, database, "webhook-e2ee-user")
	chanID := seedVoiceChannel(t, database, "webhook-e2ee-ch")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, vs == nil)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, user.ID, send)
	ws.SetClientVoiceStateForTest(c, chanID, vs.JoinedAt)
	ws.SetClientE2EEPubKeyForTest(c, "fake-ecdh-pubkey")
	hub.RegisterNowForTest(c)

	hub.HandleWebhookParticipantLeftForTest(user.ID, chanID, vs.JoinedAt)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Errorf("voice channel = %d after matching webhook cleanup, want 0", got)
	}
	if got := ws.GetClientE2EEPubKeyForTest(c); got != "" {
		t.Errorf("E2EE pub key = %q after matching webhook cleanup, want cleared", got)
	}

	dbState, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after webhook: %v", err)
	}
	if dbState != nil {
		t.Error("voice_states row still present after matching webhook cleanup")
	}
}

// TestWebhook_ParticipantLeft_LeaverWithoutReadStillNotified locks OC-0038:
// voice membership is gated on CONNECT_VOICE alone, so a participant can be
// in a voice channel without READ_MESSAGES on it. The webhook-driven teardown
// clears the leaver's own client voice state before broadcasting, so
// broadcastVoiceEvent's audience — (READ_MESSAGES holders) ∪ (still-in-the-
// room participants) — can no longer see them, and they never learn the
// server already tore down their call. finishVoiceLeave and
// CleanupVoiceForChannel both add the leaver to the audience for exactly
// this reason; the webhook path must too.
func TestWebhook_ParticipantLeft_LeaverWithoutReadStillNotified(t *testing.T) {
	t.Parallel()
	hub, database := newVoiceHub(t)

	chanID := seedVoiceChannel(t, database, "webhook-noread-ch")

	// Role 3 (Moderator) carries CONNECT_VOICE in its default mask but lacks
	// the Administrator bit, so a channel-scoped READ_MESSAGES deny actually
	// applies — an Owner/Admin role would bypass channel_overrides entirely.
	if _, err := database.CreateUser(context.Background(), "webhook-noread-user", "hash", 3); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	leaver, err := database.GetUserByUsername(context.Background(), "webhook-noread-user")
	if err != nil || leaver == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if err := database.UpsertChannelOverride(context.Background(), chanID, 3, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}

	if err := database.JoinVoiceChannel(context.Background(), leaver.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(context.Background(), leaver.ID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, vs == nil)
	}

	leaverSend := make(chan []byte, 16)
	c := ws.NewTestClient(hub, leaver.ID, leaverSend)
	ws.SetClientVoiceStateForTest(c, chanID, vs.JoinedAt)
	hub.RegisterNowForTest(c)

	hub.HandleWebhookParticipantLeftForTest(leaver.ID, chanID, vs.JoinedAt)

	if got := countVoiceLeaves(leaverSend, 200*time.Millisecond); got == 0 {
		t.Error("the leaver's own client, denied READ_MESSAGES on the voice channel, received no voice_leave after the LiveKit webhook tore down its own session")
	}
}

// TestWebhook_ParticipantLeft_SurvivesCancelledRequestContext locks OC-0018:
// the webhook handler must not tie its teardown broadcast to the triggering
// HTTP request's context. Every sibling teardown path detaches before doing
// cleanup work (readPump's defer and unregisterFailedHandshake use
// context.WithoutCancel in serve_pumps.go/serve.go, rollbackVoiceJoin uses it
// in voice_join.go, the hub sweeps use context.Background in hub_sweep.go) —
// the webhook handler alone passed r.Context() straight through. If the
// webhook sender (LiveKit) hangs up mid-request, net/http cancels that
// context; channelReadAudience's GetChannel call then fails and
// channelReadAudience fails closed to []int64{} (hub_broadcast.go), silently
// dropping any observer who has READ_MESSAGES on the channel but is not
// currently in the room from the voice_leave audience. Unlike the DB row,
// nothing ever re-emits that missed broadcast, so the observer's UI shows the
// departed participant forever.
func TestWebhook_ParticipantLeft_SurvivesCancelledRequestContext(t *testing.T) {
	t.Parallel()
	hub, database := newVoiceHub(t)

	chanID := seedVoiceChan(t, database, "webhook-ctxcancel-ch")

	leaver := seedVoiceOwner(t, database, "webhook-ctxcancel-leaver")
	observer := seedVoiceOwner(t, database, "webhook-ctxcancel-observer")

	if err := database.JoinVoiceChannel(context.Background(), leaver.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(context.Background(), leaver.ID)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, vs == nil)
	}

	leaverSend := make(chan []byte, 16)
	leaverClient := ws.NewTestClient(hub, leaver.ID, leaverSend)
	ws.SetClientVoiceStateForTest(leaverClient, chanID, vs.JoinedAt)
	hub.RegisterNowForTest(leaverClient)

	// The observer has READ_MESSAGES on the channel (Owner role bypasses
	// channel_overrides) but is not in the room — exactly the audience member
	// channelReadAudience's role scan exists to reach, and the only one an
	// empty-audience fail-close silently drops.
	observerSend := make(chan []byte, 16)
	observerClient := ws.NewTestClient(hub, observer.ID, observerSend)
	hub.RegisterNowForTest(observerClient)

	// Simulate net/http cancelling the request context because the webhook
	// sender (LiveKit) hung up before the handler finished — exactly what
	// r.Context() looks like by the time a slow cleanup path reads it.
	cancelledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	hub.HandleWebhookParticipantLeftWithContextForTest(cancelledCtx, leaver.ID, chanID, vs.JoinedAt)

	if got := countVoiceLeaves(observerSend, 200*time.Millisecond); got == 0 {
		t.Error("observer with READ_MESSAGES but outside the room received no voice_leave when the webhook's request context was already cancelled — the teardown broadcast must detach from the triggering request context")
	}
}

// ---------------------------------------------------------------------------
// livekit_process.go – generateConfig tests
// ---------------------------------------------------------------------------

func TestGenerateConfig_WritesYAML(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret",
		LiveKitURL:       "ws://localhost:7880",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, dataDir)

	cfgPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}

	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}

	got := string(content)

	for _, want := range []string{
		"port: 7880",
		`"testkey": "testsecret"`,
		"port_range_start: 50000",
		"port_range_end: 60000",
		"use_external_ip: true",
		"level: info",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("config missing %q.\nGot:\n%s", want, got)
		}
	}

	if strings.Contains(got, "node_ip") {
		t.Error("config should not contain node_ip when NodeIP is empty")
	}
}

func TestGenerateConfig_WithNodeIP(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "203.0.113.10",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, dataDir)

	cfgPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}

	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}

	got := string(content)
	if !strings.Contains(got, `node_ip: "203.0.113.10"`) {
		t.Errorf("expected node_ip in config.\nGot:\n%s", got)
	}
}

func TestGenerateConfig_UnsafeCredentialChars(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		key    string
		secret string
	}{
		{"colon in key", "bad:key", "secret"},
		{"newline in secret", "key", "bad\nsecret"},
		{"hash in key", "bad#key", "secret"},
		{"brace in secret", "key", "bad{secret"},
		{"backslash in key", `bad\key`, "secret"},
		{"quote in secret", "key", `bad"secret`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			cfg := &config.VoiceConfig{
				LiveKitAPIKey:    tt.key,
				LiveKitAPISecret: tt.secret,
				LiveKitURL:       "ws://localhost:7880",
			}
			tlsCfg := &config.TLSConfig{}
			proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

			_, err := proc.GenerateConfigForTest()
			if err == nil {
				t.Error("expected error for unsafe YAML character, got nil")
			}
		})
	}
}

// The rejection error is wrapped by Start() and logged by the caller, so it
// must never echo any part of the credential it rejected — quoting even the
// single offending byte writes a piece of a secret to the server log in clear
// text (CodeQL go/clear-text-logging). It must still name the field at fault.
func TestGenerateConfig_UnsafeCredentialErrorDoesNotLeakCredential(t *testing.T) {
	t.Parallel()

	const (
		key    = "sup3rsecret:apikey"
		secret = "sup3rsecret{apisecret"
	)

	for _, tt := range []struct {
		name  string
		key   string
		sec   string
		field string
		leak  string
	}{
		{"key", key, "safesecret", "voice.livekit_api_key", key},
		{"secret", "safekey", secret, "voice.livekit_api_secret", secret},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			proc := ws.NewLiveKitProcess(&config.VoiceConfig{
				LiveKitAPIKey:    tt.key,
				LiveKitAPISecret: tt.sec,
				LiveKitURL:       "ws://localhost:7880",
			}, &config.TLSConfig{}, t.TempDir())

			_, err := proc.GenerateConfigForTest()
			if err == nil {
				t.Fatal("expected an error for the unsafe credential, got nil")
			}
			msg := err.Error()
			if strings.Contains(msg, tt.leak) {
				t.Errorf("error leaks the credential verbatim: %q", msg)
			}
			// The distinctive prefix must not appear even partially quoted.
			if strings.Contains(msg, "sup3rsecret") {
				t.Errorf("error leaks part of the credential: %q", msg)
			}
			if !strings.Contains(msg, tt.field) {
				t.Errorf("error should name the offending field %q, got %q", tt.field, msg)
			}
		})
	}
}

func TestGenerateConfig_UnsafeNodeIPChars(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "safekey",
		LiveKitAPISecret: "safesecret",
		LiveKitURL:       "ws://localhost:7880",
		NodeIP:           "192.168.1.1\n  evil: true",
	}
	tlsCfg := &config.TLSConfig{}
	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	_, err := proc.GenerateConfigForTest()
	if err == nil {
		t.Error("expected error for unsafe node_ip character, got nil")
	}
}

func TestGenerateConfig_WithAdvertiseInternalIP(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:       "key1",
		LiveKitAPISecret:    "secret1",
		LiveKitURL:          "ws://localhost:7880",
		NodeIP:              "203.0.113.10",
		AdvertiseInternalIP: true,
	}
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, t.TempDir())

	cfgPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}

	got := string(content)
	if !strings.Contains(got, "advertise_internal_ip: true") {
		t.Errorf("expected advertise_internal_ip in config.\nGot:\n%s", got)
	}
	if !strings.Contains(got, `node_ip: "203.0.113.10"`) {
		t.Errorf("expected node_ip alongside advertise_internal_ip.\nGot:\n%s", got)
	}
}

func TestGenerateConfig_DefaultOmitsAdvertiseInternalIP(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
	}
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, t.TempDir())

	cfgPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}

	if strings.Contains(string(content), "advertise_internal_ip") {
		t.Error("config should not contain advertise_internal_ip by default")
	}
}

func TestGenerateConfig_PreservesUserManagedFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	userContent := "# my custom livekit config\nport: 7880\nrtc:\n  ips:\n    includes: [10.0.0.0/8]\n"
	if err := os.WriteFile(cfgPath, []byte(userContent), 0o600); err != nil {
		t.Fatalf("writing user config: %v", err)
	}

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
	}
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, dataDir)

	gotPath, err := proc.GenerateConfigForTest()
	if err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	if gotPath != cfgPath {
		t.Errorf("expected path %q, got %q", cfgPath, gotPath)
	}

	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}
	if string(content) != userContent {
		t.Errorf("user-managed livekit.yaml was modified.\nWant:\n%s\nGot:\n%s", userContent, content)
	}
}

func TestGenerateConfig_RegeneratesEmptyFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	// A zero-byte/whitespace-only file is a truncated leftover, not a
	// user-managed config — it must be regenerated.
	if err := os.WriteFile(cfgPath, []byte("  \n"), 0o600); err != nil {
		t.Fatalf("writing empty config: %v", err)
	}

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
	}
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, dataDir)

	if _, err := proc.GenerateConfigForTest(); err != nil {
		t.Fatalf("generateConfig: %v", err)
	}
	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}
	if !strings.Contains(string(content), `"key1": "secret1"`) {
		t.Errorf("empty livekit.yaml was not regenerated.\nGot:\n%s", content)
	}
}

func TestGenerateConfig_OverwritesAutoGeneratedFile(t *testing.T) {
	t.Parallel()

	dataDir := t.TempDir()
	cfgPath := filepath.Join(dataDir, "livekit.yaml")
	old := "# Auto-generated by OwnCord — do not edit manually.\nport: 7880\nstale: true\n"
	if err := os.WriteFile(cfgPath, []byte(old), 0o600); err != nil {
		t.Fatalf("writing old config: %v", err)
	}

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key1",
		LiveKitAPISecret: "secret1",
		LiveKitURL:       "ws://localhost:7880",
	}
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, dataDir)

	if _, err := proc.GenerateConfigForTest(); err != nil {
		t.Fatalf("generateConfig: %v", err)
	}

	content, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("reading config file: %v", err)
	}
	got := string(content)
	if strings.Contains(got, "stale: true") {
		t.Error("auto-generated livekit.yaml was not regenerated")
	}
	if !strings.Contains(got, `"key1": "secret1"`) {
		t.Errorf("regenerated config missing keys.\nGot:\n%s", got)
	}
}

// ---------------------------------------------------------------------------
// livekit_process.go – Start guard tests
// ---------------------------------------------------------------------------

func TestStart_AlreadyRunningGuard(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "/nonexistent/livekit-server",
	}
	tlsCfg := &config.TLSConfig{}
	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	proc.SetProcessCmdForTest()

	err := proc.Start()
	if err == nil {
		t.Fatal("expected error when process already running, got nil")
	}
	if !strings.Contains(err.Error(), "already running") {
		t.Errorf("expected 'already running' error, got: %v", err)
	}
}

func TestStart_StoppedGuard(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:     "key",
		LiveKitAPISecret:  "secret",
		LiveKitURL:        "ws://localhost:7880",
		LiveKitBinaryPath: "/nonexistent/livekit-server",
	}
	tlsCfg := &config.TLSConfig{}
	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	proc.SetProcessStoppedForTest()

	err := proc.Start()
	if err != nil {
		t.Fatalf("Start() on stopped process returned error: %v", err)
	}

	proc.Stop()
	if proc.IsRunning() {
		t.Error("expected IsRunning() = false after Stop()")
	}
}

// ---------------------------------------------------------------------------
// livekit_process.go – HealthCheck tests
// ---------------------------------------------------------------------------

func TestHealthCheck_Success(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	wsURL := "ws://" + srv.Listener.Addr().String()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       wsURL,
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	ok, err := proc.HealthCheck(context.Background())
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if !ok {
		t.Error("expected HealthCheck to return true")
	}
}

// httptest.Server.Close calls CloseIdleConnections on the process-wide
// http.DefaultTransport, so a health-check client that falls back to it can have
// a pooled connection severed mid-request by any unrelated parallel test closing
// its own server ("http: CloseIdleConnections called"). The client must own its
// transport — in production that also keeps the health check off the connection
// pool every other DefaultTransport user in the process shares.
func TestHealthCheckClientOwnsItsTransport(t *testing.T) {
	t.Parallel()

	proc := ws.NewLiveKitProcess(&config.VoiceConfig{}, &config.TLSConfig{}, t.TempDir())

	tr := proc.HTTPTransportForTest()
	if tr == nil {
		t.Fatal("health-check client has no Transport, so it falls back to http.DefaultTransport")
	}
	if tr == http.DefaultTransport {
		t.Error("health-check client shares http.DefaultTransport's connection pool")
	}
}

func TestHealthCheck_ServerDown(t *testing.T) {
	t.Parallel()

	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       "ws://127.0.0.1:1",
	}
	tlsCfg := &config.TLSConfig{}

	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	ok, err := proc.HealthCheck(context.Background())
	if err == nil {
		t.Fatal("expected error for unreachable server, got nil")
	}
	if ok {
		t.Error("expected HealthCheck to return false on error")
	}
}

func TestHealthCheck_NonOKStatus(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	wsURL := "ws://" + srv.Listener.Addr().String()
	cfg := &config.VoiceConfig{
		LiveKitAPIKey:    "key",
		LiveKitAPISecret: "secret",
		LiveKitURL:       wsURL,
	}
	tlsCfg := &config.TLSConfig{}
	proc := ws.NewLiveKitProcess(cfg, tlsCfg, t.TempDir())

	ok, err := proc.HealthCheck(context.Background())
	if err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}
	if !ok {
		t.Error("expected HealthCheck to return true even for 500 status")
	}
}

// ---------------------------------------------------------------------------
// livekit_webhook.go – NewLiveKitWebhookHandler tests
// ---------------------------------------------------------------------------

func TestWebhookHandler_MissingAuthHeader(t *testing.T) {
	t.Parallel()

	hub := ws.NewHubForTest()
	handler := hub.NewLiveKitWebhookHandler("api-key", "api-secret")

	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestWebhookHandler_InvalidToken(t *testing.T) {
	t.Parallel()

	hub := ws.NewHubForTest()
	handler := hub.NewLiveKitWebhookHandler("api-key", "api-secret")

	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook",
		strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer not-a-valid-jwt-token")
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for invalid token, got %d", rec.Code)
	}
}

func TestWebhookHandler_EmptyBody(t *testing.T) {
	t.Parallel()

	hub := ws.NewHubForTest()
	handler := hub.NewLiveKitWebhookHandler("api-key", "api-secret")

	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook",
		strings.NewReader(""))
	rec := httptest.NewRecorder()

	handler(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for missing auth, got %d", rec.Code)
	}
}

// signedWebhookRequest builds the request LiveKit itself would send: the body
// hashed with sha256, that hash carried as the token's sha256 claim, and the
// token signed with the shared secret. bodyToSign is what the token commits
// to; bodySent is what actually travels — passing different values simulates a
// captured token replayed against a forged payload.
func signedWebhookRequest(t *testing.T, apiKey, apiSecret, bodyToSign, bodySent string) *http.Request {
	t.Helper()

	sum := sha256.Sum256([]byte(bodyToSign))
	token, err := auth.NewAccessToken(apiKey, apiSecret).
		SetValidFor(5 * time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).
		ToJWT()
	if err != nil {
		t.Fatalf("minting webhook token: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook", strings.NewReader(bodySent))
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/webhook+json")
	return req
}

// webhookBody renders the protojson payload LiveKit posts for a participant
// event. pad is an unknown field the parser discards, used only to push the
// body past the size cap.
func webhookBody(event string, userID, channelID int64, joinToken, pad string) string {
	return fmt.Sprintf(
		`{"event":%q,"room":{"name":%q},"participant":{"identity":%q},"pad":%q}`,
		event, ws.RoomName(channelID), participantIdentityFor(userID, joinToken), pad)
}

// TestWebhookHandler_SignedParticipantLeftDispatches is the only webhook test
// that gets past ReceiveWebhookEvent: it mints a real LiveKit webhook token
// over the real body and asserts the handler both dispatches the event (the
// voice_states row is cleared) and answers 200. Without it, the 401 tests above
// would all still pass if verification were changed to reject everything.
func TestWebhookHandler_SignedParticipantLeftDispatches(t *testing.T) {
	t.Parallel()

	const apiKey, apiSecret = "webhook-signed-key", "webhook-signed-secret-0123456789"

	hub, database := newVoiceHub(t)
	user := seedVoiceOwner(t, database, "webhook-signed-user")
	chanID := seedVoiceChan(t, database, "webhook-signed-ch")

	if err := database.JoinVoiceChannel(context.Background(), user.ID, chanID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	state, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil || state == nil {
		t.Fatalf("GetVoiceState: %v (nil=%v)", err, state == nil)
	}

	body := webhookBody("participant_left", user.ID, chanID, state.JoinedAt, "")
	rec := httptest.NewRecorder()
	hub.NewLiveKitWebhookHandler(apiKey, apiSecret)(rec,
		signedWebhookRequest(t, apiKey, apiSecret, body, body))

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for a correctly signed webhook, got %d (%s)",
			rec.Code, strings.TrimSpace(rec.Body.String()))
	}

	after, err := database.GetVoiceState(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("GetVoiceState after webhook: %v", err)
	}
	if after != nil {
		t.Errorf("participant_left verified but never dispatched: voice state still present (channel %d)",
			after.ChannelID)
	}
}

// TestWebhookHandler_SignedRequestRejections covers the two ways a request
// carrying a genuinely signed token must still be refused: the token's
// body-hash claim not matching the body it arrived with (a captured token
// replayed against a forged payload), and a body past webhookMaxBodyBytes.
func TestWebhookHandler_SignedRequestRejections(t *testing.T) {
	t.Parallel()

	const apiKey, apiSecret = "webhook-reject-key", "webhook-reject-secret-0123456789"

	signed := webhookBody("participant_left", 7, 42, "tok", "")
	// Same token, different body: only the sha256 claim binding catches this.
	mutated := webhookBody("participant_left", 8, 42, "tok", "")
	// Correctly signed, but larger than webhookMaxBodyBytes — only the
	// MaxBytesReader cap catches this one.
	oversize := webhookBody("participant_left", 7, 42, "tok", strings.Repeat("a", ws.WebhookMaxBodyBytesForTest))

	tests := []struct {
		name       string
		bodyToSign string
		bodySent   string
	}{
		{"token replayed against a mutated body", signed, mutated},
		{"body over webhookMaxBodyBytes", oversize, oversize},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			hub := ws.NewHubForTest()
			rec := httptest.NewRecorder()
			hub.NewLiveKitWebhookHandler(apiKey, apiSecret)(rec,
				signedWebhookRequest(t, apiKey, apiSecret, tt.bodyToSign, tt.bodySent))

			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d", rec.Code)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// livekit_webhook.go – MountWebhookRoute tests
// ---------------------------------------------------------------------------

func TestMountWebhookRoute_RegistersRoute(t *testing.T) {
	t.Parallel()

	hub := ws.NewHubForTest()
	handler := ws.MountWebhookRoute(hub, "key", "secret")

	if handler == nil {
		t.Fatal("MountWebhookRoute returned nil handler")
	}

	r := chi.NewRouter()
	r.Post("/livekit/webhook", handler)

	req := httptest.NewRequest(http.MethodPost, "/livekit/webhook",
		strings.NewReader(`{}`))
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code == http.StatusNotFound {
		t.Error("expected route to be registered, got 404")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 from mounted webhook handler, got %d", rec.Code)
	}
}
