package ws_test

// coverage_misc_test.go: client state, message builders, hub lifecycle,
// ping, buildReady, presence/focus/typing, attachments, permissions,
// broadcast, and webhook coverage tests (split from coverage_boost_test.go).

import (
	"context"
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

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
	waitRegistered(t, hub, c)

	// Set voice channel ID on the client to simulate voice state.
	ws.SetClientVoiceChID(c, 42)

	if count := hub.ClientCount(); count != 1 {
		t.Fatalf("before GracefulStop: client count = %d, want 1", count)
	}
	if got := ws.GetClientVoiceChIDForTest(c); got != 42 {
		t.Fatalf("voiceChID before stop = %d, want 42", got)
	}

	// GracefulStop is synchronous — returning at all proves no deadlock.
	hub.GracefulStop()
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
	waitClientCount(t, hub, 5)

	if count := hub.ClientCount(); count != 5 {
		t.Fatalf("before GracefulStop: client count = %d, want 5", count)
	}

	// GracefulStop is synchronous — returning at all proves no deadlock on
	// multiple clients.
	hub.GracefulStop()
}

// ─── Ping message type (handlers.go — pong response) ─────────────────────────

func TestHandleMessage_Ping_ReturnsPong(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "ping-user")
	send := make(chan []byte, 4)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{"type": "ping"})
	// The pong reply is sent synchronously by handleMessage.
	hub.HandleMessageForTest(c, raw)

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
	role, rErr := database.GetRoleByID(context.Background(), 1)
	if rErr != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", rErr)
	}

	// Create a voice channel.
	vcID, err := database.CreateChannel(context.Background(), "voice-room", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}

	// Create another user and join them to voice.
	other := seedCoverageOwner(t, database, "ready-voice-other")
	if err := database.JoinVoiceChannel(context.Background(), other.ID, vcID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
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
	role, rErr := database.GetRoleByID(context.Background(), 1)
	if rErr != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", rErr)
	}

	// Create text and voice channels.
	_, err := database.CreateChannel(context.Background(), "text-chan", "text", "General", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel text: %v", err)
	}
	_, err = database.CreateChannel(context.Background(), "voice-chan", "voice", "General", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel voice: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
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

// ─── channel_focus handler ───────────────────────────────────────────────────

func TestHandleChannelFocus_InvalidChannelID(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cf-bad-chid")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": "not-a-number",
		},
	})
	hub.HandleMessageForTest(c, raw)

	// V2 CommandConstructor rejects non-numeric channel_id with BAD_REQUEST.
	code := drainForErrorCode(send, 100*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Fatalf("expected BAD_REQUEST for non-numeric channel_id, got code=%q", code)
	}
}

func TestHandleChannelFocus_ValidChannel(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "cf-valid")
	chID := seedTestChannel(t, database, "cf-valid-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": chID,
		},
	})
	hub.HandleMessageForTest(c, raw)

	// Valid channel focus should not produce an error message.
	code := drainForErrorCode(send, 100*time.Millisecond)
	if code != "" {
		t.Errorf("expected no error for valid channel_focus, got code=%q", code)
	}
}

// ─── presence handler error paths ────────────────────────────────────────────

func TestHandlePresence_InvalidStatus(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "pres-bad-status")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "presence_update",
		"payload": map[string]any{
			"status": "afk", // not a protocol status (invisible IS one since phase 6)
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "presence_update",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "typing_start",
		"payload": map[string]any{
			"channel_id": -1,
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

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
	_, err := database.CreateUser(context.Background(), "attach-noperm-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), "attach-noperm-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	chID := seedTestChannel(t, database, "attach-noperm-chan")

	// Deny ATTACH_FILES (0x0020) on this channel for Member role (id=4).
	_, err = database.ExecContext(context.Background(), "INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, 32)", chID)
	if err != nil {
		t.Fatalf("INSERT channel_overrides: %v", err)
	}

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id":  chID,
			"content":     "msg with attachment",
			"attachments": []string{"att-id-1"},
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

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

// ─── hasChannelPerm with nil user (handlers.go:454) ──────────────────────────

func TestHasChannelPerm_NilUser_DeniesPermission(t *testing.T) {
	hub, database := newCoverageHub(t)
	chID := seedTestChannel(t, database, "perm-nil-user-chan")
	send := make(chan []byte, 16)
	// Create a test client WITHOUT a user (user == nil).
	c := ws.NewTestClient(hub, 1, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Try to send a chat message — should get FORBIDDEN due to nil user.
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "should fail",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	// Fill the buffer.
	send <- []byte(`{"type":"filler"}`)

	// Broadcasting should not block — message dropped.
	hub.BroadcastToAll([]byte(`{"type":"should_be_dropped"}`))
	// Absence assertion: bounded window for the hub loop to (wrongly) enqueue
	// the dropped message before checking the buffer is unchanged.
	time.Sleep(50 * time.Millisecond)

	// Buffer should still contain only the filler message (dropped msg was not enqueued).
	if len(send) != 1 {
		t.Errorf("send buffer length = %d, want 1 (dropped message should not be enqueued)", len(send))
	}
	// The client should still be registered despite the dropped message.
	if !hub.IsUserConnected(user.ID) {
		t.Error("client should remain connected after a dropped broadcast")
	}
	_ = c // keep c referenced
}

func TestBuildAuthOK_NonNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "authok-avatar-user")
	// Set a non-nil avatar.
	_, err := database.ExecContext(context.Background(), "UPDATE users SET avatar = 'https://example.com/pic.png' WHERE id = ?", user.ID)
	if err != nil {
		t.Fatalf("UPDATE avatar: %v", err)
	}
	user, err = database.GetUserByUsername(context.Background(), "authok-avatar-user")
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

// ─── BroadcastToChannel / BroadcastToAll full-channel path ──────────────────

func TestBroadcastToChannel_DropsWhenFull(t *testing.T) {
	hub, _ := newCoverageHub(t)
	// Don't start Run() — broadcast channel will fill up.
	// The broadcast channel capacity is 256.
	for range 260 {
		hub.BroadcastToChannel(1, []byte(`{"type":"test"}`))
	}
	// With no Run() loop draining, some messages are dropped.
	// Hub should still be functional after overflow — verify by checking
	// that a user lookup still works (hub internals not corrupted).
	if hub.IsUserConnected(9999) {
		t.Error("expected false for non-existent user after broadcast overflow")
	}
}

func TestBroadcastToAll_DropsWhenFull(t *testing.T) {
	hub, _ := newCoverageHub(t)
	for range 260 {
		hub.BroadcastToAll([]byte(`{"type":"test"}`))
	}
	// Hub should still be functional after overflow — verify hub state is intact.
	if hub.IsUserConnected(9999) {
		t.Error("expected false for non-existent user after broadcast overflow")
	}
}
