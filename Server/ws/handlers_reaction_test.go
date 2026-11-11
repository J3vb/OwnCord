package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── handleReaction ───────────────────────────────────────────────────────────

// TestReaction_AddReaction_BroadcastsReactionUpdate verifies that adding a
// valid reaction broadcasts a reaction_update event.
func TestReaction_AddReaction_BroadcastsReactionUpdate(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner1")
	chID := seedTestChannel(t, database, "react-chan1")
	msgID := seedMessage(t, database, chID, user.ID, "react to me")

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "👍"))

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
	if err := database.AddReaction(context.Background(), msgID, user.ID, "❤️"); err != nil {
		t.Fatalf("seedReaction: %v", err)
	}

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, reactionMsg("reaction_remove", msgID, "❤️"))

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

	c, send := connectClient(t, hub, user, chID, 16)

	raw := envelope("reaction_add", "bad")
	hub.HandleMessageForTest(c, raw)

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, ""))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for empty emoji, got %q", code)
	}
}

// TestReaction_TooLongEmoji_ReturnsBadRequest verifies that an emoji string
// past the reaction length cap is rejected. The cap is derived from the custom
// emoji shortcode limit (32) plus its two colons, so a reaction has to clear 34
// runes to be refused.
func TestReaction_TooLongEmoji_ReturnsBadRequest(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner5")
	chID := seedTestChannel(t, database, "react-chan5")
	msgID := seedMessage(t, database, chID, user.ID, "msg5")

	c, send := connectClient(t, hub, user, chID, 16)

	// 35 runes — one past the ":" + 32-rune shortcode + ":" ceiling.
	longEmoji := strings.Repeat("a", 35)
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, longEmoji))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "a\x01b"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for control char in emoji, got %q", code)
	}
}

// TestReaction_NonExistentMessage_ReturnsNotFound verifies that reacting to
// a non-existent message returns the single NOT_FOUND answer shared with
// deleted and unreadable messages.
func TestReaction_NonExistentMessage_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner7")
	chID := seedTestChannel(t, database, "react-chan7")

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", 99999, "👍"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("expected NOT_FOUND for non-existent message, got %q", code)
	}
}

// TestReaction_DuplicateAdd_ReturnsCONFLICT verifies that adding the same
// emoji twice returns a CONFLICT error (DB unique constraint).
func TestReaction_DuplicateAdd_ReturnsConflict(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-owner8")
	chID := seedTestChannel(t, database, "react-chan8")
	msgID := seedMessage(t, database, chID, user.ID, "msg8")

	c, send := connectClient(t, hub, user, chID, 32)

	// First add — should succeed.
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "🔥"))
	drainChanTimeout(send, 30*time.Millisecond) // clear the first broadcast

	// Second add of the same emoji — should fail with CONFLICT.
	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "🔥"))

	code := drainForErrorCode(send, 300*time.Millisecond)
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

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", 0, "👍"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "BAD_REQUEST" {
		t.Errorf("expected BAD_REQUEST for message_id=0, got %q", code)
	}
}

// ─── BUG-126: Deleted messages must not be reactable ─────────────────────────

func TestReaction_DeletedMessage_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "react-del-owner")
	chID := seedTestChannel(t, database, "react-del-chan")
	msgID := seedMessage(t, database, chID, user.ID, "to be deleted")

	// Soft-delete the message.
	if err := database.DeleteMessage(context.Background(), msgID, user.ID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	c, send := connectClient(t, hub, user, chID, 16)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "👍"))

	code := drainForErrorCode(send, 300*time.Millisecond)
	if code != "NOT_FOUND" {
		t.Errorf("expected NOT_FOUND for reacting to deleted message, got %q", code)
	}
}

// TestReaction_UnreadableChannel_ReturnsNotFound verifies that add and remove
// on a message in a channel the caller cannot read answer NOT_FOUND, the same
// code as a missing message, and write nothing.
func TestReaction_UnreadableChannel_ReturnsNotFound(t *testing.T) {
	hub, database := newHandlerHub(t)
	owner := seedOwnerUser(t, database, "react-unread-owner")
	member := seedMemberUser(t, database, "react-unread-member")
	chID := seedTestChannel(t, database, "react-unread-chan")
	msgID := seedMessage(t, database, chID, owner.ID, "hidden")
	// Member role (4) is denied READ_MESSAGES on this channel.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		chID, permissions.ReadMessages); err != nil {
		t.Fatalf("seed override: %v", err)
	}

	c, send := connectClient(t, hub, member, chID, 16)

	for _, typ := range []string{"reaction_add", "reaction_remove"} {
		hub.HandleMessageForTest(c, reactionMsg(typ, msgID, "👍"))
		if code := drainForErrorCode(send, 300*time.Millisecond); code != "NOT_FOUND" {
			t.Errorf("%s: error code = %q, want NOT_FOUND", typ, code)
		}
	}
	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil || len(counts) != 0 {
		t.Errorf("reactions = %v, err = %v, want none", counts, err)
	}
}

// TestReaction_CapErrorCode verifies that a 21st distinct emoji is refused with
// REACTION_LIMIT and that nothing is broadcast.
func TestReaction_CapErrorCode(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedMemberUser(t, database, "reaction-cap")
	chID := seedTestChannel(t, database, "reaction-cap-chan")
	msgID := seedMessage(t, database, chID, user.ID, "popular")
	for i := range db.MaxDistinctReactions {
		if _, err := database.ExecContext(context.Background(),
			`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)`, msgID, user.ID, fmt.Sprintf("e%d", i)); err != nil {
			t.Fatalf("seed reaction: %v", err)
		}
	}

	c, send := connectClient(t, hub, user, chID, 32)

	hub.HandleMessageForTest(c, reactionMsg("reaction_add", msgID, "👍"))

	deadline := time.After(500 * time.Millisecond)
	code := ""
	for code == "" {
		select {
		case m := <-send:
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Code string `json:"code"`
				} `json:"payload"`
			}
			if json.Unmarshal(m, &env) != nil {
				continue
			}
			if env.Type == "reaction_update" {
				t.Fatalf("reaction_update broadcast for a refused reaction: %s", m)
			}
			if env.Type == "error" {
				code = env.Payload.Code
			}
		case <-deadline:
			t.Fatal("no error frame received")
		}
	}
	if code != "REACTION_LIMIT" {
		t.Errorf("error code = %q, want REACTION_LIMIT", code)
	}
	if extra := receiveMsgOfType(send, "reaction_update", 150*time.Millisecond); extra != nil {
		t.Errorf("reaction_update broadcast after the refusal: %v", extra)
	}
}
