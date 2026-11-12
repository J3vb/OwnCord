package ws_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── handleChatEdit ───────────────────────────────────────────────────────────

// TestChatEdit_ValidEdit_BroadcastsChatEdited verifies that editing an owned
// message succeeds and broadcasts a chat_edited event to channel members.
func TestChatEdit_ValidEdit_BroadcastsChatEdited(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-owner1")
	chID := seedTestChannel(t, database, "edit-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "original content")

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, "edited content"))

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

	c, send := connectClient(t, hub, user, chID, 16)

	// Send a chat_edit envelope with an unparseable payload.
	raw := envelope("chat_edit", "not-an-object")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, ""))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, editor, chID, 16)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, "stolen edit"))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	raw := envelope("chat_edit", map[string]any{
		"message_id": 0,
		"content":    "hello",
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))

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

	c, send := connectClient(t, hub, mod, chID, 32)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))

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

	c, send := connectClient(t, hub, other, chID, 16)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	raw := envelope("chat_delete", "bad")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, chatDeleteMsg(99999))

	// Handler returns FORBIDDEN (not NOT_FOUND) to prevent message-ID enumeration.
	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "FORBIDDEN" {
		t.Errorf("expected FORBIDDEN for non-existent message, got %q", code)
	}
}

// TestChatDelete_InvalidMessageID_ReturnsBadRequest verifies that message_id=0
// is rejected before any DB lookup.
func TestChatDelete_InvalidMessageID_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-owner6")
	chID := seedTestChannel(t, database, "del-chan6")

	c, send := connectClient(t, hub, user, chID, 16)

	raw := envelope("chat_delete", map[string]any{
		"message_id": 0,
	})
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for message_id=0, got %q", code)
	}
}

// TestChatEdit_RateLimit_ReturnsError verifies that exceeding the chat edit
// rate limit returns a RATE_LIMITED error.
func TestChatEdit_RateLimit_ReturnsError(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-rl1")
	chID := seedTestChannel(t, database, "edit-rl-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "original")

	c, send := connectClient(t, hub, user, chID, 64)

	// Exhaust the rate limit (chatRateLimit = 10 per second).
	for i := range 11 {
		hub.HandleMessageForTest(c, chatEditMsg(msgID, fmt.Sprintf("edit-%d", i)))
	}

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED for excess chat edits, got %q", code)
	}
}

// TestChatDelete_RateLimit_ReturnsError verifies that exceeding the chat delete
// rate limit returns a RATE_LIMITED error.
func TestChatDelete_RateLimit_ReturnsError(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "del-rl1")
	chID := seedTestChannel(t, database, "del-rl-chan1")

	// Seed enough messages to attempt deleting.
	msgIDs := make([]int64, 11)
	for i := range msgIDs {
		msgIDs[i] = seedMessage(t, database, chID, user.ID, fmt.Sprintf("msg-%d", i))
	}

	c, send := connectClient(t, hub, user, chID, 64)

	// Exhaust the rate limit (chatRateLimit = 10 per second).
	for _, id := range msgIDs {
		hub.HandleMessageForTest(c, chatDeleteMsg(id))
	}

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "RATE_LIMITED" {
		t.Errorf("expected RATE_LIMITED for excess chat deletes, got %q", code)
	}
}

// ─── BUG-126: Deleted messages must not be editable ─────────────────────────

func TestChatEdit_DeletedMessage_ReturnsAlreadyDeleted(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "edit-del-owner")
	chID := seedTestChannel(t, database, "edit-del-chan")
	msgID := seedMessage(t, database, chID, user.ID, "to be deleted")

	// Soft-delete the message.
	if err := database.DeleteMessage(context.Background(), msgID, user.ID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, chatEditMsg(msgID, "ghost edit"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "ALREADY_DELETED" {
		t.Errorf("expected ALREADY_DELETED for editing a deleted message, got %q", code)
	}
}

// TestChatDelete_AuthorWithoutSend_BroadcastsChatDeleted verifies C29: a member
// whose SEND_MESSAGES is denied on the channel still deletes their own message.
func TestChatDelete_AuthorWithoutSend_BroadcastsChatDeleted(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "del-nosend")
	chID := seedTestChannel(t, database, "del-nosend-chan")
	msgID := seedMessage(t, database, chID, user.ID, "written before the mute")
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		chID, permissions.MemberRoleID, permissions.SendMessages); err != nil {
		t.Fatalf("deny SEND: %v", err)
	}

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, chatDeleteMsg(msgID))

	payload := receiveMsgOfType(send, "chat_deleted", 300*time.Millisecond)
	if payload == nil {
		t.Fatal("expected chat_deleted broadcast, got none")
	}
	if gotID, _ := payload["message_id"].(float64); int64(gotID) != msgID {
		t.Errorf("chat_deleted message_id = %v, want %d", gotID, msgID)
	}
}
