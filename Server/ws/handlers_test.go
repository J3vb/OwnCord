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
