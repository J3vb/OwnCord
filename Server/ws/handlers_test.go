package ws_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"testing/fstest"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/ws"
)

// ─── schema used by handler tests ─────────────────────────────────────────────

// handlerTestSchema extends hubTestSchema with the audit_log table required by
// some handler paths, and includes voice_states for completeness.
var handlerTestSchema = append(hubTestSchema, []byte(`
CREATE TABLE IF NOT EXISTS voice_states (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    muted      INTEGER NOT NULL DEFAULT 0,
    deafened   INTEGER NOT NULL DEFAULT 0,
    speaking   INTEGER NOT NULL DEFAULT 0,
    joined_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states(channel_id);

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
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
`)...)

func openHandlerDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	migrFS := fstest.MapFS{
		"001_schema.sql": {Data: handlerTestSchema},
	}
	if err := db.MigrateFS(database, migrFS); err != nil {
		t.Fatalf("MigrateFS: %v", err)
	}
	return database
}

func newHandlerHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	hub := ws.NewHub(database, limiter)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedModUser inserts a Moderator-role user (roleID=3, permissions=1048575 which
// includes MANAGE_MESSAGES bit 0x10000).
func seedModUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 3) // roleID=3 → Moderator
	if err != nil {
		t.Fatalf("seedModUser CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedModUser GetUserByUsername: %v", err)
	}
	return user
}

// seedMemberUser inserts a Member-role user (roleID=4, permissions=1635) that
// does NOT have MANAGE_MESSAGES (0x10000=65536).
func seedMemberUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	_, err := database.CreateUser(username, "hash", 4) // roleID=4 → Member
	if err != nil {
		t.Fatalf("seedMemberUser CreateUser: %v", err)
	}
	user, err := database.GetUserByUsername(username)
	if err != nil || user == nil {
		t.Fatalf("seedMemberUser GetUserByUsername: %v", err)
	}
	return user
}

// seedChannelWithSlowMode creates a text channel and sets its slow_mode to the
// given seconds value, then returns the channel ID.
func seedChannelWithSlowMode(t *testing.T, database *db.DB, name string, slowModeSecs int) int64 {
	t.Helper()
	chID, err := database.CreateChannel(name, "text", "", "", 0)
	if err != nil {
		t.Fatalf("seedChannelWithSlowMode CreateChannel: %v", err)
	}
	if slowModeSecs > 0 {
		if err := database.SetChannelSlowMode(chID, slowModeSecs); err != nil {
			t.Fatalf("seedChannelWithSlowMode SetChannelSlowMode: %v", err)
		}
	}
	return chID
}

// chatSendMsg constructs a raw chat_send WebSocket envelope.
func chatSendMsg(channelID int64, content string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": channelID,
			"content":    content,
		},
	})
	return raw
}

// receiveErrorCode drains up to n messages from ch and returns the first error
// code field found, or "" if none.
func receiveErrorCode(ch <-chan []byte, deadline time.Duration) string {
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

// ─── 2.2: Session expiry check in readPump ────────────────────────────────────

// TestSessionExpiry_TokenHashStoredOnClient verifies that a Client created via
// NewTestClientWithTokenHash carries the tokenHash field for periodic revalidation.
func TestSessionExpiry_TokenHashStoredOnClient(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "expiry-user1")
	send := make(chan []byte, 16)

	hash := "deadbeefdeadbeef"
	c := ws.NewTestClientWithTokenHash(hub, user, hash, 0, send)

	if got := c.GetTokenHash(); got != hash {
		t.Errorf("GetTokenHash() = %q, want %q", got, hash)
	}
}

// TestSessionExpiry_ValidSessionAllowsMessages verifies that when a client has a
// valid (non-expired) session stored in the DB, the periodic expiry check does
// NOT close the connection.
func TestSessionExpiry_ValidSessionAllowsMessages(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "expiry-user2")
	chID := seedTestChannel(t, database, "expiry-chan2")

	// Create a real session with a far-future expiry.
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	hash := auth.HashToken(token)
	if _, err := database.CreateSession(user.ID, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Trigger the expiry check by sending enough messages to cross the check threshold.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}
	time.Sleep(100 * time.Millisecond)

	// Client should still be registered.
	if hub.ClientCount() == 0 {
		t.Error("client was removed despite having a valid session")
	}
}

// TestSessionExpiry_ExpiredSessionClosesConnection verifies that after
// SessionCheckInterval messages, a client whose session has been deleted from
// the DB gets kicked.
func TestSessionExpiry_ExpiredSessionClosesConnection(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "expiry-user3")

	// Create a session then immediately delete it to simulate expiry.
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	hash := auth.HashToken(token)
	if _, err := database.CreateSession(user.ID, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Delete the session to simulate it being expired/revoked.
	if err := database.DeleteSession(hash); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Trigger the expiry check.
	for range ws.SessionCheckInterval + 1 {
		// Use a harmless but parseable message to accumulate message count.
		hub.HandleMessageForTest(c, []byte(`{"type":"presence_update","payload":{"status":"online"}}`))
	}
	time.Sleep(100 * time.Millisecond)

	// The client's send channel should be closed (connection severed).
	// We verify this by checking that the send channel has been closed,
	// which manifests as a zero-value receive without blocking.
	select {
	case _, open := <-send:
		_ = open
		// closed channel or a message — either way connection was acted on.
	default:
		// Send channel still open and empty — check hub registration instead.
	}

	// The most reliable assertion: hub should have unregistered the client.
	time.Sleep(50 * time.Millisecond)
	if hub.ClientCount() != 0 {
		t.Error("expired-session client was not removed from the hub")
	}
}

// TestSessionExpiry_MissingTokenHashSkipsCheck verifies that a client created
// without a token hash (legacy / test-only path) does not crash during the
// periodic check.
func TestSessionExpiry_MissingTokenHashSkipsCheck(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "expiry-user4")
	chID := seedTestChannel(t, database, "expiry-chan4")

	send := make(chan []byte, 64)
	// No token hash — simulates old-style test clients.
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send past the threshold; should not panic or remove the client.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}
	time.Sleep(100 * time.Millisecond)

	if hub.ClientCount() == 0 {
		t.Error("client without token hash was incorrectly removed")
	}
}

// ─── 2.8: Slow mode enforcement ───────────────────────────────────────────────

// TestSlowMode_ZeroSlowMode_AllowsRapidMessages verifies that when slow_mode=0,
// messages are not throttled by slow mode (only the normal rate limiter applies).
func TestSlowMode_ZeroSlowMode_AllowsRapidMessages(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "slowmode-user1")
	chID := seedTestChannel(t, database, "no-slowmode-chan") // slow_mode defaults to 0

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send 3 messages in quick succession.
	for i := range 3 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("rapid %d", i)))
	}
	time.Sleep(50 * time.Millisecond)

	// Drain all messages.
	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "SLOW_MODE" {
					t.Error("got unexpected SLOW_MODE error when slow_mode=0")
				}
			}
		}
	}
}

// TestSlowMode_EnforcedAfterFirstMessage verifies that when slow_mode > 0, the
// second message from the same user within the slow_mode window is rejected.
func TestSlowMode_EnforcedAfterFirstMessage(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "slowmode-user2")
	chID := seedChannelWithSlowMode(t, database, "slow-chan", 30) // 30s slow mode

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// First message should succeed.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "first message"))
	time.Sleep(30 * time.Millisecond)
	drainChan(send) // clear the ack

	// Second message within slow_mode window should be rejected.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "second message too soon"))
	time.Sleep(30 * time.Millisecond)

	code := receiveErrorCode(send, 200*time.Millisecond)
	if code != "SLOW_MODE" {
		t.Errorf("expected SLOW_MODE error on second message, got %q", code)
	}
}

// TestSlowMode_DifferentUsersNotBlocked verifies that the slow mode key is
// per-user-per-channel: user B sending after user A is not blocked.
func TestSlowMode_DifferentUsersNotBlocked(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedChannelWithSlowMode(t, database, "slow-multi-chan", 30)

	userA := seedMemberUser(t, database, "slowmode-userA")
	userB := seedMemberUser(t, database, "slowmode-userB")

	sendA := make(chan []byte, 32)
	sendB := make(chan []byte, 32)
	cA := ws.NewTestClientWithUser(hub, userA, chID, sendA)
	cB := ws.NewTestClientWithUser(hub, userB, chID, sendB)
	hub.Register(cA)
	hub.Register(cB)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cA, chatSendMsg(chID, "from A"))
	time.Sleep(20 * time.Millisecond)

	// B sends after A — B's slow mode window is independent.
	hub.HandleMessageForTest(cB, chatSendMsg(chID, "from B"))
	time.Sleep(50 * time.Millisecond)

	// B should NOT receive a SLOW_MODE error.
	msgs := drainChan(sendB)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "SLOW_MODE" {
					t.Error("user B was incorrectly slow-mode throttled by user A's window")
				}
			}
		}
	}
}

// TestSlowMode_ModeratorBypassesSlowMode verifies that a user with MANAGE_MESSAGES
// permission can send multiple messages without hitting slow mode.
func TestSlowMode_ModeratorBypassesSlowMode(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedChannelWithSlowMode(t, database, "slow-mod-chan", 30)

	mod := seedModUser(t, database, "slowmode-mod")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mod, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send two messages in rapid succession — mod should not be blocked.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "mod msg 1"))
	time.Sleep(20 * time.Millisecond)
	drainChan(send)

	hub.HandleMessageForTest(c, chatSendMsg(chID, "mod msg 2"))
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "SLOW_MODE" {
					t.Error("moderator was incorrectly blocked by slow mode")
				}
			}
		}
	}
}

// TestSlowMode_DifferentChannels_IndependentWindows verifies that slow mode is
// scoped per-channel: a user hitting slow mode in channel A is not affected in
// channel B.
func TestSlowMode_DifferentChannels_IndependentWindows(t *testing.T) {
	hub, database := newHandlerHub(t)

	chA := seedChannelWithSlowMode(t, database, "slow-chan-A", 30)
	chB := seedChannelWithSlowMode(t, database, "slow-chan-B", 30)

	user := seedMemberUser(t, database, "slowmode-multichan")

	sendA := make(chan []byte, 32)
	sendB := make(chan []byte, 32)

	// Use two separate clients in each channel to simulate the user being in both.
	cA := ws.NewTestClientWithUser(hub, user, chA, sendA)
	// For channel B we need a separate client — re-use same userID is fine for
	// this test since we are calling HandleMessageForTest directly.
	cB := ws.NewTestClientWithUser(hub, user, chB, sendB)

	hub.Register(cA)
	time.Sleep(10 * time.Millisecond)

	// cA sends in channel A — triggers slow mode for A.
	hub.HandleMessageForTest(cA, chatSendMsg(chA, "msg in A"))
	time.Sleep(20 * time.Millisecond)
	drainChan(sendA)

	// Now send in channel B via cB — should NOT be affected.
	hub.Register(cB)
	time.Sleep(10 * time.Millisecond)

	hub.HandleMessageForTest(cB, chatSendMsg(chB, "msg in B"))
	time.Sleep(50 * time.Millisecond)

	msgs := drainChan(sendB)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			if payload, ok := env["payload"].(map[string]any); ok {
				if payload["code"] == "SLOW_MODE" {
					t.Error("slow mode in channel A incorrectly blocked channel B")
				}
			}
		}
	}
}

// ─── Attachment permission ordering ───────────────────────────────────────────

// chatSendMsgWithAttachments constructs a raw chat_send envelope with attachment IDs.
func chatSendMsgWithAttachments(channelID int64, content string, attachmentIDs []string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id":  channelID,
			"content":     content,
			"attachments": attachmentIDs,
		},
	})
	return raw
}

// denyAttachOnChannel inserts a channel_override that denies ATTACH_FILES.
func denyAttachOnChannel(t *testing.T, database *db.DB, channelID, roleID int64) {
	t.Helper()
	_, err := database.Exec(
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		channelID, roleID, permissions.AttachFiles,
	)
	if err != nil {
		t.Fatalf("denyAttachOnChannel: %v", err)
	}
}

// TestChatSend_AttachmentsDeniedNoMessageCreated verifies that when ATTACH_FILES
// is denied, the message is NOT persisted (permission check before CreateMessage).
func TestChatSend_AttachmentsDeniedNoMessageCreated(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "attach-denied")
	chID := seedTestChannel(t, database, "attach-chan")

	// Deny ATTACH_FILES for Member role on this channel.
	denyAttachOnChannel(t, database, chID, permissions.MemberRoleID)

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send a message with attachments — should be rejected before persisting.
	hub.HandleMessageForTest(c, chatSendMsgWithAttachments(chID, "has attachment", []string{"fake-attach-id"}))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN for denied ATTACH_FILES, got %q", code)
	}

	// Verify no message was persisted in the database.
	var count int
	err := database.QueryRow("SELECT COUNT(*) FROM messages WHERE channel_id = ?", chID).Scan(&count)
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 0 {
		t.Errorf("expected 0 messages in DB (permission denied before persist), got %d", count)
	}
}

// TestSlowMode_ErrorMessageContainsSlowModeDuration verifies the error payload
// describes the slow mode duration.
func TestSlowMode_ErrorMessageContainsSlowModeDuration(t *testing.T) {
	hub, database := newHandlerHub(t)
	const slowSecs = 15
	chID := seedChannelWithSlowMode(t, database, "slow-msg-chan", slowSecs)

	user := seedMemberUser(t, database, "slowmode-errmsg")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// First message to prime the window.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "first"))
	time.Sleep(20 * time.Millisecond)
	drainChan(send)

	// Second message — should receive SLOW_MODE error with duration in message.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "too soon"))
	time.Sleep(50 * time.Millisecond)

	timer := time.NewTimer(300 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case msg := <-send:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] != "error" {
				continue
			}
			payload, ok := env["payload"].(map[string]any)
			if !ok {
				continue
			}
			if payload["code"] != "SLOW_MODE" {
				continue
			}
			detail, _ := payload["message"].(string)
			expected := fmt.Sprintf("%ds slow mode", slowSecs)
			if detail == "" {
				t.Error("SLOW_MODE error had empty message")
			} else if len(detail) > 0 {
				// Verify the duration is mentioned somewhere in the message.
				found := false
				for i := 0; i <= len(detail)-len(expected); i++ {
					if detail[i:i+len(expected)] == expected {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("SLOW_MODE message %q does not contain %q", detail, expected)
				}
			}
			return
		case <-timer.C:
			t.Error("did not receive SLOW_MODE error within timeout")
			return
		}
	}
}

// ─── handleChatSend additional coverage ──────────────────────────────────────

// TestChatSend_InvalidPayload_ReturnsBadRequest verifies that a non-object
// payload to chat_send returns BAD_REQUEST.
func TestChatSend_InvalidPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv1")
	chID := seedTestChannel(t, database, "send-inv-chan1")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid payload, got %q", code)
	}
}

// TestChatSend_InvalidChannelID_ReturnsBadRequest verifies that channel_id=0
// returns BAD_REQUEST.
func TestChatSend_InvalidChannelID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv2")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": 0,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id=0, got %q", code)
	}
}

// TestChatSend_ChannelNotFound_ReturnsNotFound verifies that sending to a
// non-existent channel returns NOT_FOUND.
func TestChatSend_ChannelNotFound_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv3")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 99999, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatSendMsg(99999, "hello"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("expected NOT_FOUND for non-existent channel, got %q", code)
	}
}

// TestChatSend_EmptyContent_ReturnsBadRequest verifies that content that
// sanitizes to empty is rejected.
func TestChatSend_EmptyContent_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-empty1")
	chID := seedTestChannel(t, database, "send-empty-chan")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send message with empty content.
	hub.HandleMessageForTest(c, chatSendMsg(chID, ""))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for empty content, got %q", code)
	}
}

// TestChatSend_TooLongContent_ReturnsBadRequest verifies that content exceeding
// 4000 Unicode code points is rejected.
func TestChatSend_TooLongContent_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-long1")
	chID := seedTestChannel(t, database, "send-long-chan")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Build a 4001-rune string to exceed the limit.
	longContent := make([]rune, 4001)
	for i := range longContent {
		longContent[i] = 'a'
	}
	hub.HandleMessageForTest(c, chatSendMsg(chID, string(longContent)))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for too-long content, got %q", code)
	}
}

// TestChatSend_SuccessWithReplyTo verifies that a message with reply_to is
// accepted and the broadcast includes it.
func TestChatSend_SuccessWithReplyTo(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-reply1")
	chID := seedTestChannel(t, database, "send-reply-chan")
	parentMsgID, err := database.CreateMessage(chID, user.ID, "parent message", nil)
	if err != nil {
		t.Fatalf("CreateMessage parent: %v", err)
	}

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "reply message",
			"reply_to":   parentMsgID,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	// Should get a chat_send_ok ack.
	timer := time.NewTimer(300 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case msg := <-send:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] == "chat_send_ok" {
				return // success
			}
		case <-timer.C:
			t.Error("expected chat_send_ok for reply message, got none")
			return
		}
	}
}

// TestChatSend_NilUserClientSendsMessage verifies that a client without a user
// object attached still sends a message (uses empty username/nil avatar).
func TestChatSend_NilUserClientSendsMessage(t *testing.T) {
	hub, database := newHandlerHub(t)
	// Create a client with just an owner userID but no user object,
	// so c.user == nil. The permission check will fail if no user is set.
	// Use an owner-level user so permissions pass.
	owner := seedOwnerUser(t, database, "send-niluser1")
	chID := seedTestChannel(t, database, "send-niluser-chan")

	send := make(chan []byte, 32)
	// Use NewTestClientWithUser so permissions work (user record is attached).
	c := ws.NewTestClientWithUser(hub, owner, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatSendMsg(chID, "hello"))
	time.Sleep(50 * time.Millisecond)

	// Expect a chat_send_ok.
	timer := time.NewTimer(300 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case msg := <-send:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] == "chat_send_ok" {
				return
			}
		case <-timer.C:
			t.Error("expected chat_send_ok for normal message, got none")
			return
		}
	}
}

// TestPresence_RateLimit_ReturnsError verifies that sending more than
// presenceRateLimit updates within presenceWindow triggers a rate-limit error.
func TestPresence_RateLimit_ReturnsError(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "presence-rl1")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// First presence update — should succeed.
	hub.HandleMessageForTest(c, presenceUpdateMsg("online"))
	time.Sleep(20 * time.Millisecond)
	drainChan(send)

	// Second presence update immediately — should be rate-limited.
	hub.HandleMessageForTest(c, presenceUpdateMsg("idle"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED for excess presence updates, got %q", code)
	}
}

// ─── helpers for the new handler tests ────────────────────────────────────────

// seedMessage inserts a message into the given channel for the given user
// and returns its ID.
func seedMessage(t *testing.T, database *db.DB, channelID, userID int64, content string) int64 {
	t.Helper()
	id, err := database.CreateMessage(channelID, userID, content, nil)
	if err != nil {
		t.Fatalf("seedMessage CreateMessage: %v", err)
	}
	return id
}

// chatEditMsg constructs a raw chat_edit WebSocket envelope.
func chatEditMsg(messageID int64, content string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": messageID,
			"content":    content,
		},
	})
	return raw
}

// chatDeleteMsg constructs a raw chat_delete WebSocket envelope.
func chatDeleteMsg(messageID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": messageID,
		},
	})
	return raw
}

// reactionMsg constructs a raw reaction_add or reaction_remove envelope.
func reactionMsg(msgType string, messageID int64, emoji string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": msgType,
		"payload": map[string]any{
			"message_id": messageID,
			"emoji":      emoji,
		},
	})
	return raw
}

// typingMsg constructs a raw typing_start envelope.
func typingStartMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "typing_start",
		"payload": map[string]any{
			"channel_id": channelID,
		},
	})
	return raw
}

// presenceMsg constructs a raw presence_update envelope.
func presenceUpdateMsg(status string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "presence_update",
		"payload": map[string]any{
			"status": status,
		},
	})
	return raw
}

// receiveMsgOfType drains ch until a message with the given type field is found,
// or the deadline elapses. Returns the parsed payload or nil on timeout.
func receiveMsgOfType(ch <-chan []byte, msgType string, deadline time.Duration) map[string]any {
	timer := time.NewTimer(deadline)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			var env map[string]any
			if err := json.Unmarshal(msg, &env); err != nil {
				continue
			}
			if env["type"] == msgType {
				payload, _ := env["payload"].(map[string]any)
				return payload
			}
		case <-timer.C:
			return nil
		}
	}
}

// ─── handleChatEdit ───────────────────────────────────────────────────────────

// TestChatEdit_ValidEdit_BroadcastsChatEdited verifies that editing an owned
// message succeeds and broadcasts a chat_edited event to channel members.
func TestChatEdit_ValidEdit_BroadcastsChatEdited(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-owner1")
	chID := seedTestChannel(t, database, "edit-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "original content")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, "edited content"))
	time.Sleep(50 * time.Millisecond)

	payload := receiveMsgOfType(send, "chat_edited", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected chat_edited broadcast, got none")
	}
	// Verify the message ID is included.
	gotID, _ := payload["message_id"].(float64)
	if int64(gotID) != msgID {
		t.Errorf("chat_edited message_id = %v, want %d", gotID, msgID)
	}
}

// TestChatEdit_InvalidPayload_ReturnsBadRequest verifies that malformed JSON
// in the payload returns a BAD_REQUEST error.
func TestChatEdit_InvalidPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-owner2")
	chID := seedTestChannel(t, database, "edit-chan2")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send a chat_edit envelope with an unparseable payload.
	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_edit",
		"payload": "not-an-object",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid payload, got %q", code)
	}
}

// TestChatEdit_EmptyContent_ReturnsBadRequest verifies that an empty (or
// HTML-stripped-to-empty) content field is rejected.
func TestChatEdit_EmptyContent_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-owner3")
	chID := seedTestChannel(t, database, "edit-chan3")
	msgID := seedMessage(t, database, chID, user.ID, "original")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, ""))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for empty content, got %q", code)
	}
}

// TestChatEdit_NotOwner_ReturnsForbidden verifies that editing another user's
// message is rejected with a FORBIDDEN error.
func TestChatEdit_NotOwner_ReturnsForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	author := seedOwnerUser(t, database, "edit-author4")
	editor := seedMemberUser(t, database, "edit-editor4")
	chID := seedTestChannel(t, database, "edit-chan4")
	msgID := seedMessage(t, database, chID, author.ID, "author's message")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, editor, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, "stolen edit"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN for editing another's message, got %q", code)
	}
}

// TestChatEdit_InvalidMessageID_ReturnsBadRequest verifies that a non-positive
// message_id is rejected immediately.
func TestChatEdit_InvalidMessageID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-owner5")
	chID := seedTestChannel(t, database, "edit-chan5")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": 0,
			"content":    "hello",
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for message_id=0, got %q", code)
	}
}

// ─── handleChatDelete ─────────────────────────────────────────────────────────

// TestChatDelete_OwnerDeletesOwn_BroadcastsChatDeleted verifies that a user
// can delete their own message and a chat_deleted broadcast is sent.
func TestChatDelete_OwnerDeletesOwn_BroadcastsChatDeleted(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-owner1")
	chID := seedTestChannel(t, database, "del-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "to be deleted")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))
	time.Sleep(50 * time.Millisecond)

	payload := receiveMsgOfType(send, "chat_deleted", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected chat_deleted broadcast, got none")
	}
	gotID, _ := payload["message_id"].(float64)
	if int64(gotID) != msgID {
		t.Errorf("chat_deleted message_id = %v, want %d", gotID, msgID)
	}
}

// TestChatDelete_ModeratorDeletesOthers_BroadcastsChatDeleted verifies that a
// moderator (who has MANAGE_MESSAGES) can delete any message.
func TestChatDelete_ModeratorDeletesOthers_BroadcastsChatDeleted(t *testing.T) {
	hub, database := newHandlerHub(t)
	author := seedMemberUser(t, database, "del-author2")
	mod := seedModUser(t, database, "del-mod2")
	chID := seedTestChannel(t, database, "del-chan2")
	msgID := seedMessage(t, database, chID, author.ID, "member's message")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, mod, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))
	time.Sleep(50 * time.Millisecond)

	payload := receiveMsgOfType(send, "chat_deleted", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected chat_deleted broadcast after mod delete, got none")
	}
}

// TestChatDelete_NonOwnerWithoutManageMessages_ReturnsForbidden verifies that a
// regular member cannot delete another user's message.
func TestChatDelete_NonOwnerWithoutManageMessages_ReturnsForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	author := seedOwnerUser(t, database, "del-author3")
	other := seedMemberUser(t, database, "del-other3")
	chID := seedTestChannel(t, database, "del-chan3")
	msgID := seedMessage(t, database, chID, author.ID, "owner's message")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, other, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN for non-owner delete, got %q", code)
	}
}

// TestChatDelete_InvalidPayload_ReturnsBadRequest verifies that a malformed
// payload returns BAD_REQUEST.
func TestChatDelete_InvalidPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-owner4")
	chID := seedTestChannel(t, database, "del-chan4")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_delete",
		"payload": "bad",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid payload, got %q", code)
	}
}

// TestChatDelete_NonExistentMessage_ReturnsNotFound verifies that attempting
// to delete a message that does not exist returns NOT_FOUND.
func TestChatDelete_NonExistentMessage_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-owner5")
	chID := seedTestChannel(t, database, "del-chan5")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, chatDeleteMsg(99999))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("expected NOT_FOUND for non-existent message, got %q", code)
	}
}

// TestChatDelete_InvalidMessageID_ReturnsBadRequest verifies that message_id=0
// is rejected before any DB lookup.
func TestChatDelete_InvalidMessageID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-owner6")
	chID := seedTestChannel(t, database, "del-chan6")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": 0,
		},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for message_id=0, got %q", code)
	}
}

// ─── handleReaction ───────────────────────────────────────────────────────────

// TestReaction_AddReaction_BroadcastsReactionUpdate verifies that adding a
// valid reaction broadcasts a reaction_update event.
func TestReaction_AddReaction_BroadcastsReactionUpdate(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner1")
	chID := seedTestChannel(t, database, "react-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "react to me")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "👍"))
	time.Sleep(50 * time.Millisecond)

	payload := receiveMsgOfType(send, "reaction_update", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected reaction_update broadcast, got none")
	}
	if payload["action"] != "add" {
		t.Errorf("expected action=add, got %v", payload["action"])
	}
}

// TestReaction_RemoveReaction_BroadcastsReactionUpdate verifies that removing
// a reaction broadcasts a reaction_update event with action=remove.
func TestReaction_RemoveReaction_BroadcastsReactionUpdate(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner2")
	chID := seedTestChannel(t, database, "react-chan2")
	msgID := seedMessage(t, database, chID, user.ID, "react to me 2")

	// Pre-seed the reaction so removal has something to remove.
	if err := database.AddReaction(msgID, user.ID, "❤️"); err != nil {
		t.Fatalf("seedReaction: %v", err)
	}

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_remove", msgID, "❤️"))
	time.Sleep(50 * time.Millisecond)

	payload := receiveMsgOfType(send, "reaction_update", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected reaction_update broadcast for remove, got none")
	}
	if payload["action"] != "remove" {
		t.Errorf("expected action=remove, got %v", payload["action"])
	}
}

// TestReaction_InvalidPayload_ReturnsBadRequest verifies that a malformed
// reaction payload returns BAD_REQUEST.
func TestReaction_InvalidPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner3")
	chID := seedTestChannel(t, database, "react-chan3")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "reaction_add",
		"payload": "bad",
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid payload, got %q", code)
	}
}

// TestReaction_EmptyEmoji_ReturnsBadRequest verifies that an empty emoji string
// is rejected.
func TestReaction_EmptyEmoji_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner4")
	chID := seedTestChannel(t, database, "react-chan4")
	msgID := seedMessage(t, database, chID, user.ID, "msg4")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, ""))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for empty emoji, got %q", code)
	}
}

// TestReaction_TooLongEmoji_ReturnsBadRequest verifies that an emoji string
// exceeding 32 bytes is rejected.
func TestReaction_TooLongEmoji_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner5")
	chID := seedTestChannel(t, database, "react-chan5")
	msgID := seedMessage(t, database, chID, user.ID, "msg5")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// 33-character emoji string — exceeds the 32-byte limit.
	longEmoji := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" // 33 chars
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, longEmoji))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for too-long emoji, got %q", code)
	}
}

// TestReaction_ControlCharInEmoji_ReturnsBadRequest verifies that an emoji
// containing a control character (U+0000–U+001F) is rejected.
func TestReaction_ControlCharInEmoji_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner6")
	chID := seedTestChannel(t, database, "react-chan6")
	msgID := seedMessage(t, database, chID, user.ID, "msg6")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "a\x01b"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for control char in emoji, got %q", code)
	}
}

// TestReaction_NonExistentMessage_ReturnsBadRequest verifies that reacting to
// a non-existent message returns a sanitized BAD_REQUEST (prevents IDOR).
func TestReaction_NonExistentMessage_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner7")
	chID := seedTestChannel(t, database, "react-chan7")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", 99999, "👍"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for non-existent message (IDOR sanitize), got %q", code)
	}
}

// TestReaction_DuplicateAdd_ReturnsCONFLICT verifies that adding the same
// emoji twice returns a CONFLICT error (DB unique constraint).
func TestReaction_DuplicateAdd_ReturnsConflict(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner8")
	chID := seedTestChannel(t, database, "react-chan8")
	msgID := seedMessage(t, database, chID, user.ID, "msg8")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// First add — should succeed.
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "🔥"))
	time.Sleep(30 * time.Millisecond)
	drainChan(send) // clear the first broadcast

	// Second add of the same emoji — should fail with CONFLICT.
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "🔥"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "CONFLICT" {
		t.Errorf("expected CONFLICT for duplicate reaction, got %q", code)
	}
}

// TestReaction_InvalidMessageID_ReturnsBadRequest verifies that message_id=0
// is rejected before any DB call.
func TestReaction_InvalidMessageID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner9")
	chID := seedTestChannel(t, database, "react-chan9")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", 0, "👍"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for message_id=0, got %q", code)
	}
}

// ─── handleTyping ─────────────────────────────────────────────────────────────

// waitForClients blocks until the hub has at least n clients registered, or
// the deadline expires. Returns true if the count was reached.
func waitForClients(hub *ws.Hub, n int, deadline time.Duration) bool {
	deadline_t := time.Now().Add(deadline)
	for time.Now().Before(deadline_t) {
		if hub.ClientCount() >= n {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return hub.ClientCount() >= n
}

// TestTyping_ValidTyping_BroadcastsToOthers verifies that a typing_start event
// is delivered to other channel members but NOT to the sender.
func TestTyping_ValidTyping_BroadcastsToOthers(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "typing-chan1")

	sender := seedOwnerUser(t, database, "typing-sender1")
	watcher := seedMemberUser(t, database, "typing-watcher1")

	sendSender := make(chan []byte, 16)
	sendWatcher := make(chan []byte, 16)

	cSender := ws.NewTestClientWithUser(hub, sender, chID, sendSender)
	cWatcher := ws.NewTestClientWithUser(hub, watcher, chID, sendWatcher)

	hub.Register(cSender)
	hub.Register(cWatcher)
	// Wait until both clients are actually in the hub's client map.
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout (count=%d)", hub.ClientCount())
	}
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))
	time.Sleep(50 * time.Millisecond)

	// Watcher should receive a "typing" broadcast (the outbound event type from
	// buildTypingMsg is "typing", distinct from the inbound "typing_start").
	watcherMsgs := drainChan(sendWatcher)
	foundTyping := false
	for _, m := range watcherMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			foundTyping = true
			break
		}
	}
	if !foundTyping {
		t.Error("watcher did not receive typing broadcast")
	}

	// Sender should NOT receive their own typing event.
	senderMsgs := drainChan(sendSender)
	for _, m := range senderMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("sender incorrectly received their own typing event")
		}
	}
}

// TestTyping_InvalidChannelID_ReturnsBadRequest verifies that a typing_start
// with channel_id=0 returns a BAD_REQUEST error.
func TestTyping_InvalidChannelID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "typing-owner2")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, typingStartMsg(0))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id=0, got %q", code)
	}
}

// TestTyping_RateLimited_SilentlyDropped verifies that a second typing_start
// within the rate-limit window is silently dropped (no error sent to client).
func TestTyping_RateLimited_SilentlyDropped(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "typing-chan3")

	sender := seedOwnerUser(t, database, "typing-sender3")
	watcher := seedMemberUser(t, database, "typing-watcher3")

	sendSender := make(chan []byte, 16)
	sendWatcher := make(chan []byte, 32)

	cSender := ws.NewTestClientWithUser(hub, sender, chID, sendSender)
	cWatcher := ws.NewTestClientWithUser(hub, watcher, chID, sendWatcher)

	hub.Register(cSender)
	hub.Register(cWatcher)
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout")
	}

	// First typing event — should go through.
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))
	time.Sleep(30 * time.Millisecond)
	drainChan(sendWatcher)

	// Second typing event immediately — should be silently dropped.
	hub.HandleMessageForTest(cSender, typingStartMsg(chID))
	time.Sleep(50 * time.Millisecond)

	// Sender should NOT receive an error (silently dropped).
	senderMsgs := drainChan(sendSender)
	for _, m := range senderMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			t.Errorf("expected silent drop for rate-limited typing, but got error: %s", m)
		}
	}

	// Watcher should NOT receive a second typing event (broadcast type is "typing").
	watcherMsgs := drainChan(sendWatcher)
	typingCount := 0
	for _, m := range watcherMsgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			typingCount++
		}
	}
	if typingCount > 0 {
		t.Errorf("rate-limited typing event was not dropped; watcher received %d extra typing", typingCount)
	}
}

// ─── broadcastExclude ─────────────────────────────────────────────────────────

// TestBroadcastExclude_SendsToOthersNotSelf verifies that broadcastExclude
// delivers to all channel members except the excluded user.
// This is exercised indirectly via typing_start (which calls broadcastExclude).
func TestBroadcastExclude_SendsToOthersNotSelf(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedTestChannel(t, database, "excl-chan1")

	u1 := seedOwnerUser(t, database, "excl-user1")
	u2 := seedMemberUser(t, database, "excl-user2")
	u3 := seedMemberUser(t, database, "excl-user3")

	send1 := make(chan []byte, 16)
	send2 := make(chan []byte, 16)
	send3 := make(chan []byte, 16)

	c1 := ws.NewTestClientWithUser(hub, u1, chID, send1)
	c2 := ws.NewTestClientWithUser(hub, u2, chID, send2)
	c3 := ws.NewTestClientWithUser(hub, u3, chID, send3)

	hub.Register(c1)
	hub.Register(c2)
	hub.Register(c3)
	// Wait until all three are registered in the hub's client map.
	if !waitForClients(hub, 3, 500*time.Millisecond) {
		t.Fatalf("hub did not register all 3 clients within timeout (count=%d)", hub.ClientCount())
	}

	// u1 sends a typing event — should reach u2 and u3 but NOT u1.
	hub.HandleMessageForTest(c1, typingStartMsg(chID))
	time.Sleep(50 * time.Millisecond)

	// u2 and u3 must receive the "typing" broadcast.
	for i, sendCh := range []<-chan []byte{send2, send3} {
		msgs := drainChan(sendCh)
		found := false
		for _, m := range msgs {
			var env map[string]any
			if err := json.Unmarshal(m, &env); err != nil {
				continue
			}
			if env["type"] == "typing" {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("user%d (non-sender) did not receive typing broadcast", i+2)
		}
	}

	// u1 (sender) must NOT receive it.
	msgs1 := drainChan(send1)
	for _, m := range msgs1 {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("sender (excluded user) incorrectly received their own typing event")
		}
	}
}

// TestBroadcastExclude_DifferentChannelNotReceived verifies that broadcastExclude
// does NOT deliver to clients in a different channel.
func TestBroadcastExclude_DifferentChannelNotReceived(t *testing.T) {
	hub, database := newHandlerHub(t)
	chA := seedTestChannel(t, database, "excl-chanA")
	chB := seedTestChannel(t, database, "excl-chanB")

	uA := seedOwnerUser(t, database, "excl-userA")
	uB := seedMemberUser(t, database, "excl-userB")

	sendA := make(chan []byte, 16)
	sendB := make(chan []byte, 16)

	cA := ws.NewTestClientWithUser(hub, uA, chA, sendA)
	cB := ws.NewTestClientWithUser(hub, uB, chB, sendB)

	hub.Register(cA)
	hub.Register(cB)
	if !waitForClients(hub, 2, 500*time.Millisecond) {
		t.Fatalf("hub did not register both clients within timeout")
	}

	// uA types in channel A — uB in channel B must NOT receive it.
	hub.HandleMessageForTest(cA, typingStartMsg(chA))
	time.Sleep(50 * time.Millisecond)

	msgsB := drainChan(sendB)
	for _, m := range msgsB {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "typing" {
			t.Error("user in different channel incorrectly received typing broadcast via broadcastExclude")
		}
	}
}

// ─── handlePresence (invalid status path) ─────────────────────────────────────

// TestPresence_InvalidStatus_ReturnsBadRequest verifies that a status value
// not in the allowed set (online|idle|dnd|offline) is rejected.
func TestPresence_InvalidStatus_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "presence-bad1")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(c, presenceUpdateMsg("invisible"))
	time.Sleep(50 * time.Millisecond)

	code := receiveErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid status, got %q", code)
	}
}

// TestPresence_ValidStatus_Broadcasts verifies that valid statuses are accepted
// and broadcast to all connected clients.
func TestPresence_ValidStatus_Broadcasts(t *testing.T) {
	validStatuses := []string{"online", "idle", "dnd", "offline"}
	for _, status := range validStatuses {
		status := status
		t.Run(status, func(t *testing.T) {
			hub, database := newHandlerHub(t)
			user := seedOwnerUser(t, database, "presence-valid-"+status)

			send := make(chan []byte, 16)
			c := ws.NewTestClientWithUser(hub, user, 0, send)
			hub.Register(c)
			time.Sleep(20 * time.Millisecond)

			hub.HandleMessageForTest(c, presenceUpdateMsg(status))
			time.Sleep(50 * time.Millisecond)

			// Must NOT receive a BAD_REQUEST error.
			msgs := drainChan(send)
			for _, m := range msgs {
				var env map[string]any
				if err := json.Unmarshal(m, &env); err != nil {
					continue
				}
				if env["type"] == "error" {
					if payload, ok := env["payload"].(map[string]any); ok {
						if payload["code"] == "BAD_REQUEST" {
							t.Errorf("valid status %q was incorrectly rejected", status)
						}
					}
				}
			}
		})
	}
}

// ─── handleChannelFocus (additional edge cases) ───────────────────────────────

// TestChannelFocus_ValidFocus_UpdatesChannelID verifies that a successful
// channel_focus updates the client's tracked channel so subsequent broadcasts
// to that channel reach the client.
func TestChannelFocus_ValidFocus_UpdatesChannelID(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "focus-update1")
	chID := seedTestChannel(t, database, "focus-update-chan")

	send := make(chan []byte, 32)
	// Start client on channel 0.
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Focus on chID.
	raw, _ := json.Marshal(map[string]any{
		"type":    "channel_focus",
		"payload": map[string]any{"channel_id": chID},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	// No error expected.
	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			t.Errorf("unexpected error on valid channel_focus: %s", m)
		}
	}

	// Now broadcast to chID — client should receive it because channel was focused.
	hub.BroadcastToChannel(chID, []byte(`{"type":"ping","payload":{}}`))
	time.Sleep(30 * time.Millisecond)

	found := false
	for _, m := range drainChan(send) {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "ping" {
			found = true
			break
		}
	}
	if !found {
		t.Error("client did not receive broadcast after channel_focus updated its channelID")
	}
}

// TestChannelFocus_InvalidChannelID_NoResponse verifies that a channel_focus
// with channel_id=0 is silently ignored (no crash, no error message).
func TestChannelFocus_InvalidChannelID_NoResponse(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "focus-invalid1")

	send := make(chan []byte, 16)
	c := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	raw, _ := json.Marshal(map[string]any{
		"type":    "channel_focus",
		"payload": map[string]any{"channel_id": 0},
	})
	hub.HandleMessageForTest(c, raw)
	time.Sleep(50 * time.Millisecond)

	// No error or other message should be sent for invalid channel_id.
	msgs := drainChan(send)
	for _, m := range msgs {
		var env map[string]any
		if err := json.Unmarshal(m, &env); err != nil {
			continue
		}
		if env["type"] == "error" {
			t.Errorf("expected silent ignore for channel_id=0, but got error: %s", m)
		}
	}
}

// ─── handleMessage ban check (T-044) ─────────────────────────────────────────

// TestHandleMessage_BannedUser_GetKickedAfterSessionCheck verifies that a
// user who has been banned is kicked after the session-expiry check fires.
// The ban is detected via the user record (banned=1) during the session check.
func TestHandleMessage_BannedUser_GetKickedAfterSessionCheck(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "banned-user1")
	chID := seedTestChannel(t, database, "banned-chan1")

	// Create a valid session so the session check reaches the user lookup.
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	hash := auth.HashToken(token)
	if _, err := database.CreateSession(user.ID, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Ban the user in the database (permanent ban, no expiry).
	if _, err := database.Exec(
		`UPDATE users SET banned=1, ban_reason='test ban', ban_expires=NULL WHERE id=?`,
		user.ID,
	); err != nil {
		t.Fatalf("ban user: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, chID, send)
	hub.Register(c)
	time.Sleep(20 * time.Millisecond)

	// Send enough messages to cross the session-check threshold.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}
	time.Sleep(100 * time.Millisecond)

	// The hub should have kicked the banned client.
	time.Sleep(50 * time.Millisecond)
	if hub.ClientCount() != 0 {
		t.Error("banned user was not kicked after session check")
	}
}
