package ws_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// ─── Authorization tests for WS channel_focus ───────────────────────────────
// These tests verify that the READ_MESSAGES permission check on channel_focus
// correctly blocks or allows access.

// channelFocusMsg constructs a raw channel_focus WebSocket envelope.
func channelFocusMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": channelID,
		},
	})
	return raw
}

// denyReadOnChannel inserts a channel_override that denies READ_MESSAGES for a
// specific role on a specific channel.
func denyReadOnChannel(t *testing.T, database *db.DB, channelID, roleID int64) {
	t.Helper()
	_, err := database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		channelID, roleID, permissions.ReadMessages,
	)
	if err != nil {
		t.Fatalf("denyReadOnChannel: %v", err)
	}
}

// TestChannelFocus_AllowedByDefault verifies that a member can focus a channel
// when no override denies READ_MESSAGES (members have it by default).
func TestChannelFocus_AllowedByDefault(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-allowed")
	chID := seedTestChannel(t, database, "focus-pub")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, channelFocusMsg(chID))
	time.Sleep(50 * time.Millisecond)

	// Should NOT receive a FORBIDDEN error.
	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "FORBIDDEN" {
					t.Error("member was incorrectly denied channel_focus on accessible channel")
				}
			}
		}
	}
}

// TestChannelFocus_DeniedByOverride verifies that channel_focus is rejected
// when READ_MESSAGES is denied via a channel override.
func TestChannelFocus_DeniedByOverride(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "focus-denied")
	chID := seedTestChannel(t, database, "focus-priv")

	// Deny READ_MESSAGES for Member role on this channel.
	denyReadOnChannel(t, database, chID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, channelFocusMsg(chID))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN error for denied channel_focus, got %q", code)
	}
}

// TestChannelFocus_AdminBypassesDeny verifies that an Owner/Admin can focus
// any channel regardless of deny overrides.
func TestChannelFocus_AdminBypassesDeny(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "focus-owner")
	chID := seedTestChannel(t, database, "focus-priv2")

	// Deny READ_MESSAGES for all non-admin roles.
	denyReadOnChannel(t, database, chID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, channelFocusMsg(chID))
	time.Sleep(50 * time.Millisecond)

	// Should NOT receive a FORBIDDEN error.
	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "FORBIDDEN" {
					t.Error("admin was incorrectly denied channel_focus")
				}
			}
		}
	}
}

// TestChatSend_DeniedWithoutSendMessages verifies that chat_send is rejected
// when READ_MESSAGES or SEND_MESSAGES is denied via a channel override.
func TestChatSend_DeniedWithoutSendMessages(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "send-denied")
	chID := seedTestChannel(t, database, "send-priv")

	// Deny READ_MESSAGES (which also blocks SEND as both are required).
	denyReadOnChannel(t, database, chID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatSendMsg(chID, "should be rejected"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN error for denied chat_send, got %q", code)
	}
}
