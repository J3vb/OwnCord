package ws_test

// coverage_chat_test.go: chat send/edit/delete, reactions, slow mode, and
// read-state coverage tests (split from coverage_boost_test.go).

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── handleChatSend additional branches (handlers.go:127 — 76.2%) ────────────

func TestHandleChatSend_EmptyContent(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "empty-content-user")
	chID := seedTestChannel(t, database, "empty-content-chan")
	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": "not-a-number",
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": 99999,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": -1,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

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

// ─── handleChatSend slow mode for non-mod user (handlers.go:164) ────────────

func TestHandleChatSend_SlowMode_EnforcedForMember(t *testing.T) {
	hub, database := newCoverageHub(t)
	_, err := database.CreateUser(context.Background(), "slow-member-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(context.Background(), "slow-member-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	// Create channel with slow mode.
	chID, err := database.CreateChannel(context.Background(), "slow-chan", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.SetChannelSlowMode(context.Background(), chID, 60); err != nil {
		t.Fatalf("SetChannelSlowMode: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "first message",
		},
	})

	// First message should succeed.
	hub.HandleMessageForTest(c, raw)
	drainChanTimeout(send, 50*time.Millisecond)

	// Second message should be rate limited by slow mode.
	raw2, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "second message",
		},
	})
	hub.HandleMessageForTest(c, raw2)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_edit",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": -1,
			"content":    "updated",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": 1,
			"content":    "",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_delete",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": -1,
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": 99999,
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "reaction_add",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      "",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      strings.Repeat("x", 33),
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": 1,
			"emoji":      "\x00bad",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
	_, err := database.CreateMessage(context.Background(), chID, user.ID, "test message", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

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

	// No error should be sent for a valid channel_focus with existing message.
	code := drainForErrorCode(send, 100*time.Millisecond)
	if code != "" {
		t.Fatalf("expected no error for valid channel_focus, got code=%q", code)
	}
}

func TestHandleChatSend_WithNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "nil-avatar-user")
	chID := seedTestChannel(t, database, "nil-avatar-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "avatar-req",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from nil avatar user",
		},
	})
	hub.HandleMessageForTest(c, raw)

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

func TestHandleChatSend_WithNonNilAvatar(t *testing.T) {
	hub, database := newCoverageHub(t)
	user := seedCoverageOwner(t, database, "avatar-user")
	// Set a non-nil avatar on the user.
	_, err := database.ExecContext(context.Background(), "UPDATE users SET avatar = 'https://example.com/avatar.png' WHERE id = ?", user.ID)
	if err != nil {
		t.Fatalf("UPDATE avatar: %v", err)
	}
	// Reload user to get updated avatar.
	user, err = database.GetUserByUsername(context.Background(), "avatar-user")
	if err != nil || user == nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}

	chID := seedTestChannel(t, database, "avatar-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"id":   "avatar-req2",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "hello from avatar user",
		},
	})
	hub.HandleMessageForTest(c, raw)

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
