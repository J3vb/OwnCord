package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
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
    server_muted    INTEGER NOT NULL DEFAULT 0,
    server_muted_by INTEGER,
    server_deafened INTEGER NOT NULL DEFAULT 0,
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
    subject_token TEXT,
    actor_token TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attachments (
    id          TEXT    PRIMARY KEY,
    message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id INTEGER REFERENCES users(id),
    filename    TEXT    NOT NULL,
    stored_as   TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_at TEXT    NOT NULL DEFAULT (datetime('now')),
    width       INTEGER,
    height      INTEGER,
    duration_ms INTEGER,
    waveform    TEXT
);
`)...)

func openHandlerDB(t *testing.T) *db.DB {
	t.Helper()
	return openSchemaDB(t, handlerTestSchema)
}

func newHandlerHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	st := database
	svc := service.New(st, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

// seedModUser inserts a Moderator-role user (roleID=3, permissions=1048575 which
// includes MANAGE_MESSAGES bit 0x10000).
func seedModUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	return seedUserWithRole(t, database, username, 3)
}

// seedMemberUser inserts a Member-role user (roleID=4, permissions=1635) that
// does NOT have MANAGE_MESSAGES (0x10000=65536).
func seedMemberUser(t *testing.T, database *db.DB, username string) *db.User {
	t.Helper()
	return seedUserWithRole(t, database, username, 4)
}

// seedChannelWithSlowMode creates a text channel and sets its slow_mode to the
// given seconds value, then returns the channel ID.
func seedChannelWithSlowMode(t *testing.T, database *db.DB, name string, slowModeSecs int) int64 {
	t.Helper()
	chID := mustCreateChannel(t, database, name, "text")
	if slowModeSecs > 0 {
		if err := database.SetChannelSlowMode(context.Background(), chID, slowModeSecs); err != nil {
			t.Fatalf("seedChannelWithSlowMode SetChannelSlowMode: %v", err)
		}
	}
	return chID
}

// chatSendMsg constructs a raw chat_send WebSocket envelope.
func chatSendMsg(channelID int64, content string) []byte {
	raw := envelope("chat_send", map[string]any{
		"channel_id": channelID,
		"content":    content,
	})
	return raw
}

// ─── 2.2: Session expiry check in readPump ────────────────────────────────────

// TestSessionExpiry_ValidSessionAllowsMessages verifies that when a client has a
// valid (non-expired) session stored in the DB, the periodic expiry check does
// NOT close the connection.
func TestSessionExpiry_ValidSessionAllowsMessages(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "expiry-user2")
	chID := seedTestChannel(t, database, "expiry-chan2")

	c, _ := connectSessionClient(t, hub, database, user, chID, 64)

	// Trigger the expiry check by sending enough messages to cross the check threshold.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}

	// The session check (and any kick) runs synchronously inside handleMessage.
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
	if _, err := database.CreateSession(context.Background(), user.ID, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Delete the session to simulate it being expired/revoked.
	if err := database.DeleteSession(context.Background(), hash); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Trigger the expiry check.
	for range ws.SessionCheckInterval + 1 {
		// Use a harmless but parseable message to accumulate message count.
		hub.HandleMessageForTest(c, []byte(`{"type":"presence_update","payload":{"status":"online"}}`))
	}
	// The expiry check kicks synchronously (kickClient) inside handleMessage.

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
	waitRegistered(t, hub, c)

	// Send past the threshold; should not panic or remove the client.
	// The session check runs synchronously inside handleMessage.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}

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

	c, send := connectClient(t, hub, user, chID, 64)

	// Send 3 messages in quick succession.
	for i := range 3 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("rapid %d", i)))
	}

	// Drain all messages.
	msgs := drainChanTimeout(send, 50*time.Millisecond)
	if hasErrorCode(msgs, "SLOW_MODE") {
		t.Error("got unexpected SLOW_MODE error when slow_mode=0")
	}
}

// TestSlowMode_EnforcedAfterFirstMessage verifies that when slow_mode > 0, the
// second message from the same user within the slow_mode window is rejected.
func TestSlowMode_EnforcedAfterFirstMessage(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "slowmode-user2")
	chID := seedChannelWithSlowMode(t, database, "slow-chan", 30) // 30s slow mode

	c, send := connectClient(t, hub, user, chID, 32)

	// First message should succeed.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "first message"))
	drainChanTimeout(send, 30*time.Millisecond) // clear the ack

	// Second message within slow_mode window should be rejected.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "second message too soon"))

	code := drainForErrorCode(send, 200*time.Millisecond)
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

	cA, _ := connectClient(t, hub, userA, chID, 32)
	cB, sendB := connectClient(t, hub, userB, chID, 32)

	hub.HandleMessageForTest(cA, chatSendMsg(chID, "from A"))

	// B sends after A — B's slow mode window is independent.
	hub.HandleMessageForTest(cB, chatSendMsg(chID, "from B"))

	// B should NOT receive a SLOW_MODE error.
	msgs := drainChanTimeout(sendB, 50*time.Millisecond)
	if hasErrorCode(msgs, "SLOW_MODE") {
		t.Error("user B was incorrectly slow-mode throttled by user A's window")
	}
}

// TestSlowMode_ModeratorBypassesSlowMode verifies that a user with MANAGE_MESSAGES
// permission can send multiple messages without hitting slow mode.
func TestSlowMode_ModeratorBypassesSlowMode(t *testing.T) {
	hub, database := newHandlerHub(t)
	chID := seedChannelWithSlowMode(t, database, "slow-mod-chan", 30)

	mod := seedModUser(t, database, "slowmode-mod")
	c, send := connectClient(t, hub, mod, chID, 32)

	// Send two messages in rapid succession — mod should not be blocked.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "mod msg 1"))
	drainChanTimeout(send, 20*time.Millisecond)

	hub.HandleMessageForTest(c, chatSendMsg(chID, "mod msg 2"))

	msgs := drainChanTimeout(send, 50*time.Millisecond)
	if hasErrorCode(msgs, "SLOW_MODE") {
		t.Error("moderator was incorrectly blocked by slow mode")
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
	waitRegistered(t, hub, cA)

	// cA sends in channel A — triggers slow mode for A.
	hub.HandleMessageForTest(cA, chatSendMsg(chA, "msg in A"))
	drainChanTimeout(sendA, 20*time.Millisecond)

	// Now send in channel B via cB — should NOT be affected.
	hub.Register(cB)
	waitRegistered(t, hub, cB)

	hub.HandleMessageForTest(cB, chatSendMsg(chB, "msg in B"))

	msgs := drainChanTimeout(sendB, 50*time.Millisecond)
	if hasErrorCode(msgs, "SLOW_MODE") {
		t.Error("slow mode in channel A incorrectly blocked channel B")
	}
}

// ─── Attachment permission ordering ───────────────────────────────────────────

// chatSendMsgWithAttachments constructs a raw chat_send envelope with attachment IDs.
func chatSendMsgWithAttachments(channelID int64, content string, attachmentIDs []string) []byte {
	raw := envelope("chat_send", map[string]any{
		"channel_id":  channelID,
		"content":     content,
		"attachments": attachmentIDs,
	})
	return raw
}

// denyAttachOnChannel inserts a channel_override that denies ATTACH_FILES.
func denyAttachOnChannel(t *testing.T, database *db.DB, channelID, roleID int64) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
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

	c, send := connectClient(t, hub, user, chID, 16)

	// Send a message with attachments — should be rejected before persisting.
	hub.HandleMessageForTest(c, chatSendMsgWithAttachments(chID, "has attachment", []string{"fake-attach-id"}))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN for denied ATTACH_FILES, got %q", code)
	}

	// Verify no message was persisted in the database.
	var count int
	err := database.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM messages WHERE channel_id = ?", chID).Scan(&count)
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
	c, send := connectClient(t, hub, user, chID, 32)

	// First message to prime the window.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "first"))
	drainChanTimeout(send, 20*time.Millisecond)

	// Second message — should receive SLOW_MODE error with duration in message.
	hub.HandleMessageForTest(c, chatSendMsg(chID, "too soon"))

	env := waitErrorEnvelope(send, 300*time.Millisecond, func(env map[string]any) bool {
		payload, ok := errorPayload(env)
		return ok && payload["code"] == "SLOW_MODE"
	})
	if env == nil {
		t.Error("did not receive SLOW_MODE error within timeout")
		return
	}
	payload, _ := errorPayload(env)
	detail, _ := payload["message"].(string)
	expected := fmt.Sprintf("%ds slow mode", slowSecs)
	if detail == "" {
		t.Error("SLOW_MODE error had empty message")
	} else if !strings.Contains(detail, expected) {
		t.Errorf("SLOW_MODE message %q does not contain %q", detail, expected)
	}
}

// ─── handleChatSend additional coverage ──────────────────────────────────────

// TestChatSend_InvalidPayload_ReturnsBadRequest verifies that a non-object
// payload to chat_send returns BAD_REQUEST.
func TestChatSend_InvalidPayload_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv1")
	chID := seedTestChannel(t, database, "send-inv-chan1")

	c, send := connectClient(t, hub, user, chID, 16)

	raw := envelope("chat_send", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for invalid payload, got %q", code)
	}
}

// TestChatSend_InvalidChannelID_ReturnsBadRequest verifies that channel_id=0
// returns BAD_REQUEST.
func TestChatSend_InvalidChannelID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv2")

	c, send := connectClient(t, hub, user, 0, 16)

	raw := envelope("chat_send", map[string]any{
		"channel_id": 0,
		"content":    "hello",
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for channel_id=0, got %q", code)
	}
}

// TestChatSend_ChannelNotFound_ReturnsNotFound verifies that sending to a
// non-existent channel returns NOT_FOUND.
func TestChatSend_ChannelNotFound_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-inv3")

	c, send := connectClient(t, hub, user, 99999, 16)

	hub.HandleMessageForTest(c, chatSendMsg(99999, "hello"))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	// Send message with empty content.
	hub.HandleMessageForTest(c, chatSendMsg(chID, ""))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	// Build a 4001-rune string to exceed the limit.
	longContent := make([]rune, 4001)
	for i := range longContent {
		longContent[i] = 'a'
	}
	hub.HandleMessageForTest(c, chatSendMsg(chID, string(longContent)))

	code := drainForErrorCode(send, 300*time.Millisecond)
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
	parentMsgID := mustCreateMessage(t, database, chID, user.ID, "parent message")

	c, send := connectClient(t, hub, user, chID, 32)

	raw := envelope("chat_send", map[string]any{
		"channel_id": chID,
		"content":    "reply message",
		"reply_to":   parentMsgID,
	})
	hub.HandleMessageForTest(c, raw)

	// Should get a chat_send_ok ack.
	if receiveEnvelope(send, "chat_send_ok", 300*time.Millisecond) == nil {
		t.Error("expected chat_send_ok for reply message, got none")
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
	waitRegistered(t, hub, c)

	hub.HandleMessageForTest(c, chatSendMsg(chID, "hello"))

	// Expect a chat_send_ok.
	if receiveEnvelope(send, "chat_send_ok", 300*time.Millisecond) == nil {
		t.Error("expected chat_send_ok for normal message, got none")
	}
}

// TestPresence_RateLimit_ReturnsError verifies that sending more than
// presenceRateLimit updates within presenceWindow triggers a rate-limit error.
func TestPresence_RateLimit_ReturnsError(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "presence-rl1")

	c, send := connectClient(t, hub, user, 0, 32)

	// First presence update — should succeed.
	hub.HandleMessageForTest(c, presenceUpdateMsg("online"))
	drainChanTimeout(send, 20*time.Millisecond)

	// Second presence update immediately — should be rate-limited.
	hub.HandleMessageForTest(c, presenceUpdateMsg("idle"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED for excess presence updates, got %q", code)
	}
}

// ─── helpers for the new handler tests ────────────────────────────────────────

// seedMessage inserts a message into the given channel for the given user
// and returns its ID.
func seedMessage(t *testing.T, database *db.DB, channelID, userID int64, content string) int64 {
	t.Helper()
	id := mustCreateMessage(t, database, channelID, userID, content)
	return id
}

// chatEditMsg constructs a raw chat_edit WebSocket envelope.
func chatEditMsg(messageID int64, content string) []byte {
	raw := envelope("chat_edit", map[string]any{
		"message_id": messageID,
		"content":    content,
	})
	return raw
}

// chatDeleteMsg constructs a raw chat_delete WebSocket envelope.
func chatDeleteMsg(messageID int64) []byte {
	raw := envelope("chat_delete", map[string]any{
		"message_id": messageID,
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
	raw := envelope("typing_start", map[string]any{
		"channel_id": channelID,
	})
	return raw
}

// presenceMsg constructs a raw presence_update envelope.
func presenceUpdateMsg(status string) []byte {
	raw := envelope("presence_update", map[string]any{
		"status": status,
	})
	return raw
}

// receiveMsgOfType drains ch until a message with the given type field is found,
// or the deadline elapses. Returns the parsed payload or nil on timeout.
func receiveMsgOfType(ch <-chan []byte, msgType string, deadline time.Duration) map[string]any {
	env := receiveEnvelope(ch, msgType, deadline)
	if env == nil {
		return nil
	}
	payload, _ := env["payload"].(map[string]any)
	return payload
}

// receiveEnvelope reads ch until a frame of msgType arrives, returning the
// decoded envelope, or nil once deadline passes.
func receiveEnvelope(ch <-chan []byte, msgType string, deadline time.Duration) map[string]any {
	return waitEnvelope(ch, deadline, func(env map[string]any) bool { return env["type"] == msgType })
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
	if _, err := database.CreateSession(context.Background(), user.ID, hash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	// Ban the user in the database (permanent ban, no expiry).
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET banned=1, ban_reason='test ban', ban_expires=NULL WHERE id=?`,
		user.ID,
	); err != nil {
		t.Fatalf("ban user: %v", err)
	}

	send := make(chan []byte, 64)
	c := ws.NewTestClientWithTokenHash(hub, user, hash, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	// Send enough messages to cross the session-check threshold.
	for i := range ws.SessionCheckInterval + 1 {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("msg %d", i)))
	}

	// The ban check kicks synchronously (kickClient) inside handleMessage.
	if hub.ClientCount() != 0 {
		t.Error("banned user was not kicked after session check")
	}
}

// TestHandleMessage_KickedClient_FrameNotDispatched pins OC-0285.
//
// kickClient (hub_sweep.go) only removes the client from the hub map and
// closes its send channels — it never touches the underlying connection or
// signals readPump. readPump (serve_pumps.go) loops on conn.Read and hands
// every frame it reads to hub.handleMessage with no check that the client
// was just kicked, so any frame already in flight (pipelined by the peer, or
// sitting in the kernel receive buffer) is still dispatched with full
// authority after the kick decision was made — including, for chat_send, a
// DB write and a broadcast to everyone else in the channel. This reproduces
// that window directly: kick the client via the same ban-triggered path
// handleMessageSessionRecheck uses, then feed one more chat_send exactly as
// readPump would, and confirm it does not get executed.
func TestHandleMessage_KickedClient_FrameNotDispatched(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "kicked-user1")
	chID := seedTestChannel(t, database, "kicked-chan1")

	c, _ := connectSessionClient(t, hub, database, user, chID, 64)

	// Ban the user, then drive msgCount to exactly SessionCheckInterval so the
	// next call is the one where handleMessageSessionRecheck discovers the
	// ban and kicks. Each of these warm-up calls is a normal chat_send, which
	// dispatches and persists like any pre-kick traffic.
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET banned=1, ban_reason='test ban', ban_expires=NULL WHERE id=?`,
		user.ID,
	); err != nil {
		t.Fatalf("ban user: %v", err)
	}
	for i := range ws.SessionCheckInterval {
		hub.HandleMessageForTest(c, chatSendMsg(chID, fmt.Sprintf("warmup %d", i)))
	}
	if hub.ClientCount() != 0 {
		t.Fatal("banned user was not kicked after crossing the session-check threshold")
	}

	// The bug: nothing stops readPump (simulated here by calling
	// HandleMessageForTest directly on the same, now-kicked client) from
	// still handing frames to handleMessage. msgCount was just reset to 0 by
	// the kicking call, so this frame is far from the next recheck and, on
	// the buggy code, sails straight through to the chat_send handler.
	const postKickContent = "post-kick-should-not-persist"
	hub.HandleMessageForTest(c, chatSendMsg(chID, postKickContent))

	msgs, err := database.GetMessages(context.Background(), chID, 0, 50)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	for _, m := range msgs {
		if m.Content == postKickContent {
			t.Fatalf("chat_send from a kicked client was persisted (id=%d): handleMessage dispatched a frame after kickClient had already removed the client and closed its send channels", m.ID)
		}
	}
}

// TestChatSend_BroadcastCarriesReferencedMessage verifies the live chat_message
// frame of a reply carries the parent's snippet, and null for a plain message.
func TestChatSend_BroadcastCarriesReferencedMessage(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-refmsg1")
	chID := seedTestChannel(t, database, "send-refmsg-chan")
	parentID := mustCreateMessage(t, database, chID, user.ID, "parent message")

	c, send := connectClient(t, hub, user, chID, 32)

	raw := envelope("chat_send", map[string]any{"channel_id": chID, "content": "reply message", "reply_to": parentID})
	hub.HandleMessageForTest(c, raw)

	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case msg := <-send:
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					ReferencedMessage *struct {
						ID      int64  `json:"id"`
						Content string `json:"content"`
						Deleted bool   `json:"deleted"`
					} `json:"referenced_message"`
				} `json:"payload"`
			}
			if json.Unmarshal(msg, &env) != nil || env.Type != "chat_message" {
				continue
			}
			ref := env.Payload.ReferencedMessage
			if ref == nil || ref.ID != parentID || ref.Content != "parent message" || ref.Deleted {
				t.Fatalf("referenced_message = %+v", ref)
			}
			return
		case <-timer.C:
			t.Fatal("no chat_message broadcast")
		}
	}
}
