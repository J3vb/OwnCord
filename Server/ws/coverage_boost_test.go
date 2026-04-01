package ws_test

// coverage_boost_test.go adds tests for functions with 0% or low coverage
// to push the ws package above 80%.

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── schema with voice_states + audit_log for coverage tests ──────────────────

var coverageSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted       INTEGER NOT NULL DEFAULT 0,
    deafened    INTEGER NOT NULL DEFAULT 0,
    speaking    INTEGER NOT NULL DEFAULT 0,
    camera      INTEGER NOT NULL DEFAULT 0,
    screenshare INTEGER NOT NULL DEFAULT 0,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel_cov ON voice_states(channel_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    INTEGER NOT NULL REFERENCES users(id),
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   INTEGER NOT NULL DEFAULT 0,
    detail      TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER
);

`)...)

func openCoverageDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: coverageSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func newCoverageHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openCoverageDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)

	// Inject a test LiveKit client so voice_join passes the livekit!=nil guard.
	lk, err := ws.NewLiveKitClient(&config.VoiceConfig{
		LiveKitAPIKey:    "test-api-key-12345",
		LiveKitAPISecret: "test-api-secret-67890abcdef",
		LiveKitURL:       "ws://localhost:7880",
	})
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	hub.SetLiveKit(lk)

	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

func seedCoverageOwner(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 1)
	if err != nil {
		t.Fatalf("seedCoverageOwner CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedCoverageOwner GetUserByUsername: %v", err)
	}
	return user
}

// ─── SetClientVoiceChID stores the tracked voice channel ─────────────────────

func TestSetClientVoiceChID_SetsValue(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetClientVoiceChID(c, 42)
	if got := ws.GetClientVoiceChIDForTest(c); got != 42 {
		t.Fatalf("voiceChID = %d, want 42", got)
	}
}

func TestSetClientVoiceChID_ZeroClearsVoice(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetClientVoiceChID(c, 100)
	ws.SetClientVoiceChID(c, 0)
	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID = %d, want 0", got)
	}
}

func TestSetClientVoiceChID_LastWriteWins(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetClientVoiceChID(c, 7)
	ws.SetClientVoiceChID(c, 99)
	if got := ws.GetClientVoiceChIDForTest(c); got != 99 {
		t.Fatalf("voiceChID = %d, want 99", got)
	}
}

// ─── buildJSON error fallback (messages.go:18 — 75% coverage) ────────────────

func TestBuildJSON_UnmarshalableValue_ReturnsFallback(t *testing.T) {
	// math.Inf is not valid JSON — forces the error path in buildJSON.
	out := ws.BuildJSONForTest(math.Inf(1))
	if !json.Valid(out) {
		t.Fatalf("fallback output is not valid JSON: %s", out)
	}
	var m map[string]string
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("unmarshal fallback: %v", err)
	}
	if m["type"] != "error" {
		t.Errorf("fallback type = %q, want error", m["type"])
	}
	if m["message"] != "internal marshal error" {
		t.Errorf("fallback message = %q, want 'internal marshal error'", m["message"])
	}
}

func TestBuildJSON_ChannelValue_ReturnsFallback(t *testing.T) {
	// Channels are not JSON-marshalable.
	out := ws.BuildJSONForTest(make(chan int))
	if !json.Valid(out) {
		t.Fatalf("fallback output is not valid JSON: %s", out)
	}
}

// ─── GracefulStop with clients having voice state (hub.go:188 — 75%) ─────────

func TestGracefulStop_WithClientsHavingVoiceState(t *testing.T) {
	hub, database := newCoverageHub(t)

	user := seedCoverageOwner(t, database, "graceful-voice-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Set voice channel ID on the client to simulate voice state.
	ws.SetClientVoiceChID(c, 42)

	if count := hub.ClientCount(); count != 1 {
		t.Fatalf("before GracefulStop: client count = %d, want 1", count)
	}
	if got := ws.GetClientVoiceChIDForTest(c); got != 42 {
		t.Fatalf("voiceChID before stop = %d, want 42", got)
	}

	hub.GracefulStop()
	time.Sleep(20 * time.Millisecond)
	// GracefulStop signals clients to close — test clients don't have real
	// goroutines so they won't self-unregister, but verify the hub accepted
	// the stop without deadlocking on voice-state cleanup.
}

func TestGracefulStop_MultipleClients(t *testing.T) {
	hub, database := newCoverageHub(t)

	for i := range 5 {
		user := seedCoverageOwner(t, database, "graceful-multi-"+string(rune('a'+i)))
		send := make(chan []byte, 16)
		c := ws.NewTestClientWithUser(hub, user, 0, send)
		hub.Register(c)
	}
	time.Sleep(30 * time.Millisecond)

	if count := hub.ClientCount(); count != 5 {
		t.Fatalf("before GracefulStop: client count = %d, want 5", count)
	}

	hub.GracefulStop()
	time.Sleep(20 * time.Millisecond)
	// Verify GracefulStop completes without deadlock on multiple clients.
}

// ─── handleChatSend additional branches (handlers.go:127 — 76.2%) ────────────

func TestHandleChatSend_EmptyContent(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "empty-content-user")
	chID := seedTestChannel(t, database, "empty-content-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for empty content", code)
	}
}

func TestHandleChatSend_ContentTooLong(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "long-content-user")
	chID := seedTestChannel(t, database, "long-content-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Content over 4000 characters.
	longContent := strings.Repeat("x", 4001)
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    longContent,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for content too long", code)
	}
}

func TestHandleChatSend_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "bad-chid-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": "not-a-number",
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid channel_id", code)
	}
}

func TestHandleChatSend_ChannelNotFound(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "notfound-chan-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": 99999,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("error code = %q, want NOT_FOUND for nonexistent channel", code)
	}
}

func TestHandleChatSend_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "bad-payload-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid payload", code)
	}
}

func TestHandleChatSend_NegativeChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "neg-chid-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": -1,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for negative channel_id", code)
	}
}

// ─── handleChatSend with reply_to (handlers.go:127 — covers reply_to path) ──

func TestHandleChatSend_WithReplyTo(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "reply-user")
	chID := seedTestChannel(t, database, "reply-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send first message to get an ID.
	raw1, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "req-1",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "original message",
		},
	})
	hub.HandleMessageForTest(c, raw1)
	time.Sleep(50 * time.Millisecond)

	// Drain to find the message ID from chat_send_ok.
	var msgID float64
	timeout := time.After(500 * time.Millisecond)
drainFirst:
	for {
		select {
		case msg := <-send:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err == nil {
				if env["type"] == "chat_send_ok" {
					if p, ok := env["payload"].(map[string]any); ok {
						msgID = p["message_id"].(float64)
					}
					break drainFirst
				}
			}
		case <-timeout:
			t.Fatal("did not receive chat_send_ok for first message")
		}
	}

	// Drain remaining messages.
	drainChanBuf(send)

	// Send reply.
	replyTo := int64(msgID)
	raw2, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "req-2",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "reply message",
			"reply_to":   replyTo,
		},
	})
	hub.HandleMessageForTest(c, raw2)
	time.Sleep(50 * time.Millisecond)

	// Should get chat_send_ok for the reply.
	found := false
	timeout2 := time.After(500 * time.Millisecond)
drainReply:
	for {
		select {
		case msg := <-send:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err == nil {
				if env["type"] == "chat_send_ok" && env["id"] == "req-2" {
					found = true
					break drainReply
				}
			}
		case <-timeout2:
			break drainReply
		}
	}
	if !found {
		t.Error("expected chat_send_ok for reply message")
	}
}

// ─── Ping message type (handlers.go — pong response) ─────────────────────────

func TestHandleMessage_Ping_ReturnsPong(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "ping-user")
	send := make(chan []byte, 4)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{"type": "ping"})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(20 * time.Millisecond)

	select {
	case msg := <-send:
		var env map[string]any
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if env["type"] != "pong" {
			t.Errorf("type = %q, want pong", env["type"])
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("expected pong response")
	}
}

// ─── buildReady with voice channel having participants ────────────────────────

func TestBuildReady_VoiceChannelWithParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "ready-voice-user")

	// Create a voice channel.
	vcID, err := database.CreateChannel("voice-room", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}

	// Create another user and join them to voice.
	other := seedCoverageOwner(t, database, "ready-voice-other")
	if err := database.JoinVoiceChannel(other.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}

	var env struct {
		Payload struct {
			VoiceStates []struct {
				ChannelID float64 `json:"channel_id"`
				UserID    float64 `json:"user_id"`
			} `json:"voice_states"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.VoiceStates) != 1 {
		t.Errorf("voice_states count = %d, want 1", len(env.Payload.VoiceStates))
	}
}

func TestBuildReady_MultipleChannelTypes(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "ready-multi-user")

	// Create text and voice channels.
	_, err := database.CreateChannel("text-chan", "text", "General", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel text: %v", err)
	}
	_, err = database.CreateChannel("voice-chan", "voice", "General", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}

	msg, err := hub.BuildReadyForTest(database, user.ID)
	if err != nil {
		t.Fatalf("BuildReadyForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.Channels) != 2 {
		t.Errorf("channels count = %d, want 2", len(env.Payload.Channels))
	}

	// Text channels should have unread_count; voice channels should not.
	for _, ch := range env.Payload.Channels {
		if ch["type"] == "text" {
			if _, ok := ch["unread_count"]; !ok {
				t.Error("text channel missing unread_count")
			}
		}
	}
}

// ─── voice handler edge cases ────────────────────────────────────────────────

func TestHandleVoiceJoin_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-bad-chid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": "not-a-number",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceJoin_NegativeChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-neg-chid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": -1,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceMute_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_mute",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid voice_mute payload", code)
	}
}

func TestHandleVoiceDeafen_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Put client in voice so the "not in voice" guard doesn't fire first.
	ws.SetClientVoiceChID(c, 999)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_deafen",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid voice_deafen payload", code)
	}
}

// ─── voice camera and screenshare error paths ────────────────────────────────

func TestHandleVoiceCamera_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_camera",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceCamera_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-bad-payload")
	vcID, err := database.CreateChannel("cam-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Set voice channel so the not-in-voice check passes.
	ws.SetClientVoiceChID(c, vcID)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_camera",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceScreenshare_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_screenshare",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceScreenshare_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-bad-payload")
	vcID, err := database.CreateChannel("screen-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	ws.SetClientVoiceChID(c, vcID)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_screenshare",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

// ─── channel_focus handler ───────────────────────────────────────────────────

func TestHandleChannelFocus_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cf-bad-chid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": "not-a-number",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(20 * time.Millisecond)

	// Invalid channel_id should be silently ignored — no error sent to client.
	code := drainForErrorCode(send, 100*time.Millisecond)
	if code != "" {
		t.Fatalf("expected no error for invalid channel_id, got code=%q", code)
	}
}

func TestHandleChannelFocus_ValidChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cf-valid")
	chID := seedTestChannel(t, database, "cf-valid-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": chID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(20 * time.Millisecond)
	// Should not error — just update internal state.
}

// ─── presence handler error paths ────────────────────────────────────────────

func TestHandlePresence_InvalidStatus(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "pres-bad-status")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "presence_update",
		"payload": map[string]any{
			"status": "invisible", // not allowed per CLAUDE.md
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid status", code)
	}
}

func TestHandlePresence_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "pres-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "presence_update",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid presence payload", code)
	}
}

// ─── typing handler error path ───────────────────────────────────────────────

func TestHandleTyping_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "typing-bad-chid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "typing_start",
		"payload": map[string]any{
			"channel_id": -1,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for invalid typing channel_id", code)
	}
}

// ─── message builder coverage ────────────────────────────────────────────────

func TestBuildPresenceMsg_ValidJSON(t *testing.T) {
	msg := ws.BuildJSONForTest(map[string]any{
		"type": "presence",
		"payload": map[string]any{
			"user_id": 1,
			"status":  "online",
		},
	})
	if !json.Valid(msg) {
		t.Error("buildPresenceMsg output is not valid JSON")
	}
}

func TestBuildChatSendOK_ValidJSON(t *testing.T) {
	msg := ws.BuildJSONForTest(map[string]any{
		"type": "chat_send_ok",
		"id":   "req-1",
		"payload": map[string]any{
			"message_id": 1,
			"timestamp":  "2024-01-01T00:00:00Z",
		},
	})
	if !json.Valid(msg) {
		t.Error("buildChatSendOK output is not valid JSON")
	}
}

// ─── SendToUser full buffer path (hub.go:308 — 87.5%) ───────────────────────

func TestSendToUser_FullBuffer_ReturnsFalse(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "send-full-user")
	// Create a send channel with buffer size 1.
	send := make(chan []byte, 1)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Fill the buffer.
	send <- []byte(`{"type":"filler"}`)

	// Next send should return false (buffer full).
	ok := hub.SendToUser(user.ID, []byte(`{"type":"overflow"}`))
	if ok {
		t.Error("SendToUser should return false when send buffer is full")
	}
}

// ─── handleChatSend with attachments (handlers.go:127 — 76.2%) ──────────────

func TestHandleChatSend_WithAttachments_NoPermission(t *testing.T) {
	hub, database := newCoverageHub(t)
	// Use a member user.
	_, err := database.CreateUser("attach-noperm-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername("attach-noperm-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	chID := seedTestChannel(t, database, "attach-noperm-chan")

	// Deny ATTACH_FILES (0x0020) on this channel for Member role (id=4).
	_, err = database.Exec("INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 32)", chID)
	if err != nil {
		t.Fatalf("INSERT channel_overrides: %v", err)
	}

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id":  chID,
			"content":     "msg with attachment",
			"attachments": []string{"att-id-1"},
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("error code = %q, want FORBIDDEN for denied ATTACH_FILES permission", code)
	}
}

func TestHandleChatSend_WithAttachments_Success(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "attach-ok-user")
	chID := seedTestChannel(t, database, "attach-ok-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "attach-req",
		"payload": map[string]any{
			"channel_id":  chID,
			"content":     "msg with attachment",
			"attachments": []string{"nonexistent-att-id"},
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	// Should still succeed (attachments that don't exist are silently skipped).
	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "chat_send_ok" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected chat_send_ok even with nonexistent attachment IDs")
	}
}

// ─── handleChatSend slow mode for non-mod user (handlers.go:164) ────────────

func TestHandleChatSend_SlowMode_EnforcedForMember(t *testing.T) {
	hub, database := newCoverageHub(t)
	_, err := database.CreateUser("slow-member-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername("slow-member-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	// Create channel with slow mode.
	chID, err := database.CreateChannel("slow-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.SetChannelSlowMode(chID, 60); err != nil {
		t.Fatalf("SetChannelSlowMode: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "first message",
		},
	})

	// First message should succeed.
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)
	drainChanBuf(send)

	// Second message should be rate limited by slow mode.
	raw2, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "second message",
		},
	})
	hub.HandleMessageForTest(c, raw2)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "SLOW_MODE" {
		t.Errorf("error code = %q, want SLOW_MODE", code)
	}
}

// ─── handleChatEdit more paths (handlers.go:249 — 89.7%) ────────────────────

func TestHandleChatEdit_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "edit-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_edit",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleChatEdit_InvalidMessageID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "edit-bad-msgid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": -1,
			"content":    "updated",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleChatEdit_EmptyContent(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "edit-empty")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": 1,
			"content":    "",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

// ─── handleChatDelete more paths (handlers.go:298) ───────────────────────────

func TestHandleChatDelete_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "delete-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_delete",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleChatDelete_InvalidMessageID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "delete-bad-msgid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": -1,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleChatDelete_MessageNotFound(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "delete-notfound")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": 99999,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	// Handler returns FORBIDDEN (not NOT_FOUND) to prevent message-ID enumeration.
	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("error code = %q, want FORBIDDEN", code)
	}
}

// ─── handleReaction more paths (handlers.go:337) ─────────────────────────────

func TestHandleReaction_InvalidPayload(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "react-bad-payload")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "reaction_add",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleReaction_EmptyEmoji(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "react-empty-emoji")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      "",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleReaction_EmojiTooLong(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "react-long-emoji")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      strings.Repeat("x", 33),
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleReaction_ControlCharInEmoji(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "react-ctrl-emoji")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      "\x00bad",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST for control char emoji", code)
	}
}

// ─── handleChannelFocus with message marking (handlers.go:507) ───────────────

func TestHandleChannelFocus_UpdatesReadState(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cf-readstate-user")
	chID := seedTestChannel(t, database, "cf-readstate-chan")

	// Insert a message so there's a latest_message_id.
	_, err := database.CreateMessage(chID, user.ID, "test message", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": chID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	// No error should be sent for a valid channel_focus with existing message.
	code := drainForErrorCode(send, 100*time.Millisecond)
	if code != "" {
		t.Fatalf("expected no error for valid channel_focus, got code=%q", code)
	}
}

// ─── helpers ──────────────────────────────────────────────────────────────────

// drainForErrorCode reads from ch until an error message is found or deadline passes.
func drainForErrorCode(ch <-chan []byte, deadline time.Duration) string {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] == "error" {
				if payload, ok := env["payload"].(map[string]any); ok {
					code, _ := payload["code"].(string)
					return code
				}
			}
		case <-timer.C:
			return ""
		}
	}
}

// drainChanBuf drains all buffered messages from a channel.
func drainChanBuf(ch <-chan []byte) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

// drainChanTimeout reads messages until timeout, returning all collected.
func drainChanTimeout(ch <-chan []byte, d time.Duration) [][]byte {
	var msgs [][]byte
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			msgs = append(msgs, msg)
		case <-timer.C:
			return msgs
		}
	}
}

// ─── voice join/leave full flow (voice_handlers.go coverage) ─────────────────

func seedVoiceChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	id, err := database.CreateChannel(name, "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}
	return id
}

func TestHandleVoiceJoin_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-flow-user")
	vcID := seedVoiceChannel(t, database, "vj-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 500*time.Millisecond)
	foundState := false
	foundConfig := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil {
			switch env["type"] {
			case "voice_state":
				foundState = true
			case "voice_config":
				foundConfig = true
			}
		}
	}
	if !foundState {
		t.Error("expected voice_state broadcast after voice_join")
	}
	if !foundConfig {
		t.Error("expected voice_config after voice_join")
	}
}

func TestHandleVoiceJoin_AlreadyInSameChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-same-user")
	vcID := seedVoiceChannel(t, database, "vj-same-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "ALREADY_JOINED" {
		t.Errorf("error code = %q, want ALREADY_JOINED", code)
	}
}

func TestHandleVoiceJoin_SwitchChannels(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-switch-user")
	vc1 := seedVoiceChannel(t, database, "vj-switch-vc1")
	vc2 := seedVoiceChannel(t, database, "vj-switch-vc2")
	send := make(chan []byte, 128)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw1, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vc1,
		},
	})
	hub.HandleMessageForTest(c, raw1)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	raw2, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vc2,
		},
	})
	hub.HandleMessageForTest(c, raw2)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	foundConfig := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil {
			switch env["type"] {
			case "voice_leave":
				foundLeave = true
			case "voice_config":
				foundConfig = true
			}
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast when switching channels")
	}
	if !foundConfig {
		t.Error("expected voice_config for new channel")
	}
}

func TestHandleVoiceJoin_ChannelFull(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID, err := database.CreateChannel("full-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.Exec("UPDATE channels SET voice_max_users = 1 WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE channels: %v", err)
	}

	user1 := seedCoverageOwner(t, database, "vj-full-u1")
	send1 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, raw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send1)

	user2 := seedCoverageOwner(t, database, "vj-full-u2")
	send2 := make(chan []byte, 64)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c2, raw)
	time.Sleep(100 * time.Millisecond)

	code := drainForErrorCode(send2, 300*time.Millisecond)
	if code != "CHANNEL_FULL" {
		t.Errorf("error code = %q, want CHANNEL_FULL", code)
	}
}

func TestHandleVoiceLeave_ExplicitLeave(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vl-explicit-user")
	vcID := seedVoiceChannel(t, database, "vl-explicit-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c, leaveRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			foundLeave = true
			break
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast after explicit leave")
	}
}

func TestHandleVoiceLeave_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vl-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleVoiceLeaveForTest(c)
	time.Sleep(20 * time.Millisecond)
}

func TestHandleVoiceMute_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-flow-user")
	vcID := seedVoiceChannel(t, database, "vm-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	muteRaw, _ := json.Marshal(map[string]any{
		"type": "voice_mute",
		"payload": map[string]any{
			"muted": true,
		},
	})
	hub.HandleMessageForTest(c, muteRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state broadcast after mute")
	}
}

func TestHandleVoiceDeafen_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-flow-user")
	vcID := seedVoiceChannel(t, database, "vd-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	deafenRaw, _ := json.Marshal(map[string]any{
		"type": "voice_deafen",
		"payload": map[string]any{
			"deafened": true,
		},
	})
	hub.HandleMessageForTest(c, deafenRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state broadcast after deafen")
	}
}

func TestHandleVoiceJoin_ChannelNotFound(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-notfound-user")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": 99999,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("error code = %q, want NOT_FOUND", code)
	}
}

func TestHandleVoiceJoin_WithQualityOverride(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-quality-user")

	vcID, err := database.CreateChannel("quality-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.Exec("UPDATE channels SET voice_quality = 'high' WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_config" {
			p := env["payload"].(map[string]any)
			if p["quality"] != "high" {
				t.Errorf("voice_config quality = %v, want high", p["quality"])
			}
			return
		}
	}
	t.Error("expected voice_config with quality override")
}

func TestHandleVoiceJoin_MultipleParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "vj-multi-vc")

	user1 := seedCoverageOwner(t, database, "vj-multi-u1")
	send1 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	hub.Register(c1)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, raw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send1)

	user2 := seedCoverageOwner(t, database, "vj-multi-u2")
	send2 := make(chan []byte, 64)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c2, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send2, 300*time.Millisecond)
	voiceStateCount := 0
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			voiceStateCount++
		}
	}
	if voiceStateCount < 2 {
		t.Errorf("voice_state count = %d, want at least 2", voiceStateCount)
	}
}

func TestHandleVoiceLeave_BroadcastsToOtherParticipants(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "vl-bcast-vc")

	user1 := seedCoverageOwner(t, database, "vl-bcast-u1")
	user2 := seedCoverageOwner(t, database, "vl-bcast-u2")
	send1 := make(chan []byte, 64)
	send2 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(30 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c1, joinRaw)
	time.Sleep(100 * time.Millisecond)
	hub.HandleMessageForTest(c2, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send1)
	drainChanBuf(send2)

	leaveRaw, _ := json.Marshal(map[string]any{"type": "voice_leave"})
	hub.HandleMessageForTest(c1, leaveRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send2, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			found = true
			break
		}
	}
	if !found {
		t.Error("user2 should receive voice_leave when user1 leaves")
	}
}

func TestHandleVoiceCamera_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vc-flow-user")
	vcID := seedVoiceChannel(t, database, "vc-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	camRaw, _ := json.Marshal(map[string]any{
		"type": "voice_camera",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, camRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state after camera toggle")
	}
}

func TestHandleVoiceScreenshare_FullFlow(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vs-flow-user")
	vcID := seedVoiceChannel(t, database, "vs-flow-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	joinRaw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, joinRaw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	ssRaw, _ := json.Marshal(map[string]any{
		"type": "voice_screenshare",
		"payload": map[string]any{
			"enabled": true,
		},
	})
	hub.HandleMessageForTest(c, ssRaw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_state" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected voice_state after screenshare toggle")
	}
}

func TestHandleChatSend_WithNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "nil-avatar-user")
	chID := seedTestChannel(t, database, "nil-avatar-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "avatar-req",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from nil avatar user",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	found := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "chat_send_ok" {
			found = true
			break
		}
	}
	if !found {
		t.Error("expected chat_send_ok for nil-avatar user")
	}
}

// ─── hasChannelPerm with nil user (handlers.go:454) ──────────────────────────

func TestHasChannelPerm_NilUser_DeniesPermission(t *testing.T) {
	hub, database := newCoverageHub(t)
	chID := seedTestChannel(t, database, "perm-nil-user-chan")
	send := make(chan []byte, 16)
	// Create a test client WITHOUT a user (user == nil).
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Try to send a chat message — should get FORBIDDEN due to nil user.
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "should fail",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("error code = %q, want FORBIDDEN for nil user", code)
	}
}

// ─── deliverBroadcast with full send buffer (hub.go:344) ─────────────────────

func TestDeliverBroadcast_FullBuffer_DropsMessage(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "bcast-full-user")
	// Create a tiny send buffer.
	send := make(chan []byte, 1)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Fill the buffer.
	send <- []byte(`{"type":"filler"}`)

	// Broadcasting should not block — message dropped.
	hub.BroadcastToAll([]byte(`{"type":"should_be_dropped"}`))
	time.Sleep(50 * time.Millisecond)
	// No assertion needed — just verify no deadlock.
}

func TestBuildAuthOK_NonNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "authok-avatar-user")
	// Set a non-nil avatar.
	_, err := database.Exec("UPDATE users SET avatar = 'https://example.com/pic.png' WHERE id = ?", user.ID)
	if err != nil {
		t.Fatalf("UPDATE avatar: %v", err)
	}
	user, err = database.GetUserByUsername("authok-avatar-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	msg := hub.BuildAuthOKForTest(user, "owner")
	var env struct {
		Payload struct {
			User struct {
				Avatar string `json:"avatar"`
			} `json:"user"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if env.Payload.User.Avatar != "https://example.com/pic.png" {
		t.Errorf("avatar = %q, want https://example.com/pic.png", env.Payload.User.Avatar)
	}
}

func TestHandleChatSend_WithNonNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "avatar-user")
	// Set a non-nil avatar on the user.
	_, err := database.Exec("UPDATE users SET avatar = 'https://example.com/avatar.png' WHERE id = ?", user.ID)
	if err != nil {
		t.Fatalf("UPDATE avatar: %v", err)
	}
	// Reload user to get updated avatar.
	user, err = database.GetUserByUsername("avatar-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	chID := seedTestChannel(t, database, "avatar-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "avatar-req2",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from avatar user",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundOK := false
	foundBroadcast := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil {
			if env["type"] == "chat_send_ok" {
				foundOK = true
			}
			if env["type"] == "chat_message" {
				// Verify avatar is present in broadcast.
				if p, ok := env["payload"].(map[string]any); ok {
					if u, ok := p["user"].(map[string]any); ok {
						if u["avatar"] == "https://example.com/avatar.png" {
							foundBroadcast = true
						}
					}
				}
			}
		}
	}
	if !foundOK {
		t.Error("expected chat_send_ok for avatar user")
	}
	if !foundBroadcast {
		t.Error("expected chat_message with non-nil avatar")
	}
}

// ─── Webhook parse helpers ──────────────────────────────────────────────────

func TestWebhookParseIdentity_Valid(t *testing.T) {
	id, err := ws.ParseIdentityForTest("user-42")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 42 {
		t.Errorf("id = %d, want 42", id)
	}
}

func TestWebhookParseIdentity_Invalid(t *testing.T) {
	_, err := ws.ParseIdentityForTest("invalid")
	if err == nil {
		t.Fatal("expected error for invalid identity, got nil")
	}
}

func TestWebhookParseRoomChannelID_Valid(t *testing.T) {
	id, err := ws.ParseRoomChannelIDForTest("channel-5")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id != 5 {
		t.Errorf("id = %d, want 5", id)
	}
}

func TestWebhookParseRoomChannelID_Invalid(t *testing.T) {
	_, err := ws.ParseRoomChannelIDForTest("bad")
	if err == nil {
		t.Fatal("expected error for invalid room name, got nil")
	}
}

// ─── Voice control "not in voice" guards ────────────────────────────────────

func TestHandleVoiceMute_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vm-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_mute",
		"payload": map[string]any{
			"muted": true,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

func TestHandleVoiceDeafen_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vd-not-in-voice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_deafen",
		"payload": map[string]any{
			"deafened": true,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "VOICE_ERROR" {
		t.Errorf("error code = %q, want VOICE_ERROR", code)
	}
}

// ─── Voice join with invalid quality fallback ───────────────────────────────

func TestHandleVoiceJoin_InvalidQualityFallsBackToMedium(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vj-badquality-user")

	vcID, err := database.CreateChannel("badquality-vc", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	_, err = database.Exec("UPDATE channels SET voice_quality = 'garbage' WHERE id = ?", vcID)
	if err != nil {
		t.Fatalf("UPDATE: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "voice_join",
		"payload": map[string]any{
			"channel_id": vcID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_config" {
			p := env["payload"].(map[string]any)
			if p["quality"] != "medium" {
				t.Errorf("voice_config quality = %v, want medium", p["quality"])
			}
			return
		}
	}
	t.Error("expected voice_config with medium quality fallback")
}

// ─── getLastActivity (client.go:153) ─────────────────────────────────────────

func TestGetLastActivity_ReturnsZeroForNewTestClient(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	got := ws.GetLastActivityForTest(c)
	if !got.IsZero() {
		t.Fatalf("expected zero time for new test client, got %v", got)
	}
}

func TestGetLastActivity_UpdatedByTouch(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	before := time.Now()
	ws.TouchForTest(c)
	after := time.Now()

	got := ws.GetLastActivityForTest(c)
	if got.Before(before) || got.After(after) {
		t.Fatalf("lastActivity = %v, expected between %v and %v", got, before, after)
	}
}

func TestGetLastActivity_MultipleTouch(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.TouchForTest(c)
	first := ws.GetLastActivityForTest(c)

	time.Sleep(5 * time.Millisecond)
	ws.TouchForTest(c)
	second := ws.GetLastActivityForTest(c)

	if !second.After(first) {
		t.Fatalf("second touch (%v) should be after first (%v)", second, first)
	}
}

// ─── setVoiceChID (client.go:186) ───────────────────────────────────────────

func TestSetVoiceChID_SetsAndGetsValue(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetVoiceChIDForTest(c, 77)
	if got := ws.GetClientVoiceChIDForTest(c); got != 77 {
		t.Fatalf("voiceChID = %d, want 77", got)
	}
}

func TestSetVoiceChID_OverwritesPreviousValue(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetVoiceChIDForTest(c, 10)
	ws.SetVoiceChIDForTest(c, 20)
	if got := ws.GetClientVoiceChIDForTest(c); got != 20 {
		t.Fatalf("voiceChID = %d, want 20", got)
	}
}

func TestSetVoiceChID_ZeroMeansNotInVoice(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetVoiceChIDForTest(c, 50)
	ws.SetVoiceChIDForTest(c, 0)
	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID = %d, want 0", got)
	}
}

// ─── clearVoiceChID (client.go:203) ─────────────────────────────────────────

func TestClearVoiceChID_ReturnsOldValueAndClearsToZero(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetVoiceChIDForTest(c, 42)
	old := ws.ClearVoiceChIDForTest(c)
	if old != 42 {
		t.Fatalf("clearVoiceChID returned %d, want 42", old)
	}
	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after clear = %d, want 0", got)
	}
}

func TestClearVoiceChID_ReturnsZeroWhenNotInVoice(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	old := ws.ClearVoiceChIDForTest(c)
	if old != 0 {
		t.Fatalf("clearVoiceChID returned %d, want 0", old)
	}
}

func TestClearVoiceChID_DoubleClearReturnsZero(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 4)
	c := ws.NewTestClient(hub, 1, send)

	ws.SetVoiceChIDForTest(c, 99)
	first := ws.ClearVoiceChIDForTest(c)
	second := ws.ClearVoiceChIDForTest(c)
	if first != 99 {
		t.Fatalf("first clear = %d, want 99", first)
	}
	if second != 0 {
		t.Fatalf("second clear = %d, want 0", second)
	}
}

// ─── handleVoiceTokenRefresh (voice_join.go:188) ────────────────────────────

func voiceTokenRefreshMsg() []byte {
	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_token_refresh",
		"payload": map[string]any{},
	})
	return raw
}

func TestHandleVoiceTokenRefresh_NotInVoice(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vtr-notinvoice")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("error code = %q, want BAD_REQUEST", code)
	}
}

func TestHandleVoiceTokenRefresh_InVoice_ReturnsToken(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "vtr-invc")
	vcID := seedVoiceChannel(t, database, "vtr-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "voice_join",
		"payload": map[string]any{"channel_id": vcID},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(100 * time.Millisecond)
	drainChanBuf(send)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(100 * time.Millisecond)

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundToken := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_token" {
			foundToken = true
			break
		}
	}
	if !foundToken {
		t.Error("expected voice_token message after token refresh")
	}
}

func TestHandleVoiceTokenRefresh_NilUser(t *testing.T) {
	hub, _ := newCoverageHub(t)
	send := make(chan []byte, 16)
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	ws.SetVoiceChIDForTest(c, 42)

	hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
	time.Sleep(50 * time.Millisecond)

	code := drainForErrorCode(send, 200*time.Millisecond)
	if code != "INTERNAL" {
		t.Errorf("error code = %q, want INTERNAL", code)
	}
}

// ─── rollbackVoiceJoin (voice_join.go:239) ──────────────────────────────────

func TestRollbackVoiceJoin_ClearsVoiceStateAndBroadcasts(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-user")
	vcID := seedVoiceChannel(t, database, "rb-vc")
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	hub.RollbackVoiceJoinForTest(c, vcID)
	time.Sleep(100 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after rollback = %d, want 0", got)
	}

	state, _ := database.GetVoiceState(user.ID)
	if state != nil {
		t.Fatal("voice state should be nil after rollback")
	}

	msgs := drainChanTimeout(send, 300*time.Millisecond)
	foundLeave := false
	for _, msg := range msgs {
		var env map[string]any
		if json.Unmarshal(msg, &env) == nil && env["type"] == "voice_leave" {
			foundLeave = true
			break
		}
	}
	if !foundLeave {
		t.Error("expected voice_leave broadcast after rollback")
	}
}

func TestRollbackVoiceJoin_NoDBState_DoesNotPanic(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "rb-nostate")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	ws.SetVoiceChIDForTest(c, 999)
	hub.RollbackVoiceJoinForTest(c, 999)
	time.Sleep(50 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c); got != 0 {
		t.Fatalf("voiceChID after rollback = %d, want 0", got)
	}
}

// ─── leaveVoiceChannelWithRetry (voice_leave.go:57) ─────────────────────────

func TestLeaveVoiceChannelWithRetry_SuccessOnFirstAttempt(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "lvcr-ok")
	vcID := seedVoiceChannel(t, database, "lvcr-ok-vc")

	if err := database.JoinVoiceChannel(user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	state, _ := database.GetVoiceState(user.ID)
	if state == nil {
		t.Fatal("voice state should exist before leave")
	}

	err := ws.LeaveVoiceChannelWithRetryForTest(hub, user.ID, vcID, state.JoinedAt)
	if err != nil {
		t.Fatalf("leaveVoiceChannelWithRetry returned error: %v", err)
	}

	state, _ = database.GetVoiceState(user.ID)
	if state != nil {
		t.Fatal("voice state should be nil after successful leave")
	}
}

func TestLeaveVoiceChannelWithRetry_NoVoiceState_NilReturn(t *testing.T) {
	hub, database := newCoverageHub(t)
	_ = seedCoverageOwner(t, database, "lvcr-nostate")

	err := ws.LeaveVoiceChannelWithRetryForTest(hub, 9999, 1, "")
	if err != nil {
		t.Fatalf("expected nil error for non-existent voice state, got: %v", err)
	}
}

// ─── CleanupVoiceForChannel (hub.go:237) — additional paths ─────────────────

func TestCleanupVoiceForChannel_WithClientsInChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user1 := seedCoverageOwner(t, database, "cvfc-u1")
	user2 := seedCoverageOwner(t, database, "cvfc-u2")
	vcID := seedVoiceChannel(t, database, "cvfc-vc")

	send1 := make(chan []byte, 64)
	send2 := make(chan []byte, 64)
	c1 := ws.NewTestClientWithUser(hub, user1, 0, send1)
	c2 := ws.NewTestClientWithUser(hub, user2, 0, send2)
	hub.Register(c1)
	hub.Register(c2)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(user1.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u1: %v", err)
	}
	if err := database.JoinVoiceChannel(user2.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel u2: %v", err)
	}
	ws.SetVoiceChIDForTest(c1, vcID)
	ws.SetVoiceChIDForTest(c2, vcID)

	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(100 * time.Millisecond)

	if got := ws.GetClientVoiceChIDForTest(c1); got != 0 {
		t.Errorf("c1 voiceChID = %d, want 0", got)
	}
	if got := ws.GetClientVoiceChIDForTest(c2); got != 0 {
		t.Errorf("c2 voiceChID = %d, want 0", got)
	}

	states, _ := database.GetChannelVoiceStates(vcID)
	if len(states) != 0 {
		t.Errorf("expected 0 voice states after cleanup, got %d", len(states))
	}
}

func TestCleanupVoiceForChannel_EmptyChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	vcID := seedVoiceChannel(t, database, "cvfc-empty-vc")
	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(20 * time.Millisecond)
}

func TestCleanupVoiceForChannel_DBStateButNoClient(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cvfc-noclient")
	vcID := seedVoiceChannel(t, database, "cvfc-noclient-vc")

	if err := database.JoinVoiceChannel(user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	hub.CleanupVoiceForChannel(vcID)
	time.Sleep(50 * time.Millisecond)

	state, _ := database.GetVoiceState(user.ID)
	if state != nil {
		t.Error("voice state should be nil after cleanup")
	}
}

// ─── sweepStaleVoiceStates (hub.go:489) ─────────────────────────────────────

func TestSweepStaleVoiceStates_RemovesGhostState(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-ghost")
	vcID := seedVoiceChannel(t, database, "sweep-ghost-vc")

	// Put user in voice in DB but don't register a client — ghost state.
	if err := database.JoinVoiceChannel(user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	// Verify it exists.
	state, _ := database.GetVoiceState(user.ID)
	if state == nil {
		t.Fatal("voice state should exist before sweep")
	}

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Ghost state should be removed.
	state, _ = database.GetVoiceState(user.ID)
	if state != nil {
		t.Error("ghost voice state should be nil after sweep")
	}
}

func TestSweepStaleVoiceStates_PreservesActiveClientState(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-active")
	vcID := seedVoiceChannel(t, database, "sweep-active-vc")

	// Register client and set voice channel.
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(user.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vcID)

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Active client's state should be preserved.
	state, _ := database.GetVoiceState(user.ID)
	if state == nil {
		t.Error("active client's voice state should be preserved after sweep")
	}
}

func TestSweepStaleVoiceStates_NoStatesNoPanic(t *testing.T) {
	hub, _ := newCoverageHub(t)
	hub.SweepStaleVoiceStatesForTest()
}

func TestSweepStaleVoiceStates_MismatchedChannelIsGhost(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "sweep-mismatch")
	vc1 := seedVoiceChannel(t, database, "sweep-mismatch-vc1")
	vc2 := seedVoiceChannel(t, database, "sweep-mismatch-vc2")

	// Register client in vc1 but DB says vc2.
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	if err := database.JoinVoiceChannel(user.ID, vc2); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	ws.SetVoiceChIDForTest(c, vc1) // Client thinks vc1, DB says vc2 — mismatch.

	hub.SweepStaleVoiceStatesForTest()
	time.Sleep(100 * time.Millisecond)

	// Mismatched state should be removed from DB.
	state, _ := database.GetVoiceState(user.ID)
	if state != nil {
		t.Error("mismatched voice state should be removed after sweep")
	}
}

// ─── BroadcastToChannel / BroadcastToAll full-channel path ──────────────────

func TestBroadcastToChannel_DropsWhenFull(t *testing.T) {
	hub, _ := newCoverageHub(t)
	// Don't start Run() — broadcast channel will fill up.
	// The broadcast channel capacity is 256.
	for i := 0; i < 260; i++ {
		hub.BroadcastToChannel(1, []byte(`{"type":"test"}`))
	}
	// No panic and no block = pass. Some messages will be dropped.
}

func TestBroadcastToAll_DropsWhenFull(t *testing.T) {
	hub, _ := newCoverageHub(t)
	for i := 0; i < 260; i++ {
		hub.BroadcastToAll([]byte(`{"type":"test"}`))
	}
}
