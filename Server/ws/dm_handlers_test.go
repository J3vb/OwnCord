package ws_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── DM test helpers ────────────────────────────────────────────────────────

// seedDMChannel creates a DM channel between two users and returns the channel ID.
func seedDMChannel(t *testing.T, database *db.DB, user1ID, user2ID int64) int64 {
	t.Helper()
	ch, _, err := database.GetOrCreateDMChannel(user1ID, user2ID)
	if err != nil {
		t.Fatalf("seedDMChannel: %v", err)
	}
	return ch.ID
}

// dmChatSendMsg constructs a raw chat_send WebSocket envelope for a DM channel.
func dmChatSendMsg(channelID int64, content string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": channelID,
			"content":    content,
		},
	})
	return raw
}

// dmChatEditMsg constructs a raw chat_edit WebSocket envelope.
func dmChatEditMsg(msgID int64, content string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_edit",
		"payload": map[string]any{
			"message_id": msgID,
			"content":    content,
		},
	})
	return raw
}

// dmChatDeleteMsg constructs a raw chat_delete WebSocket envelope.
func dmChatDeleteMsg(msgID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "chat_delete",
		"payload": map[string]any{
			"message_id": msgID,
		},
	})
	return raw
}

// dmTypingMsg constructs a raw typing_start WebSocket envelope.
func dmTypingMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "typing_start",
		"payload": map[string]any{
			"channel_id": channelID,
		},
	})
	return raw
}

// dmChannelFocusMsg constructs a raw channel_focus WebSocket envelope.
func dmChannelFocusMsg(channelID int64) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "channel_focus",
		"payload": map[string]any{
			"channel_id": channelID,
		},
	})
	return raw
}

// dmReactionAddMsg constructs a raw reaction_add WebSocket envelope.
func dmReactionAddMsg(msgID int64, emoji string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_add",
		"payload": map[string]any{
			"message_id": msgID,
			"emoji":      emoji,
		},
	})
	return raw
}

// dmReactionRemoveMsg constructs a raw reaction_remove WebSocket envelope.
func dmReactionRemoveMsg(msgID int64, emoji string) []byte {
	raw, _ := json.Marshal(map[string]any{
		"type": "reaction_remove",
		"payload": map[string]any{
			"message_id": msgID,
			"emoji":      emoji,
		},
	})
	return raw
}

// dmDrainAll non-blocking drains all messages currently in the channel buffer.
func dmDrainAll(ch <-chan []byte) []map[string]any {
	var result []map[string]any
	for {
		select {
		case raw := <-ch:
			var env map[string]any
			if err := json.Unmarshal(raw, &env); err == nil {
				result = append(result, env)
			}
		default:
			return result
		}
	}
}

// dmFindMsgType returns the first message of the given type from a slice of envelopes.
func dmFindMsgType(msgs []map[string]any, msgType string) map[string]any {
	for _, m := range msgs {
		if m["type"] == msgType {
			return m
		}
	}
	return nil
}

// dmFindErrorCode returns the error code from the first error message, or "".
func dmFindErrorCode(msgs []map[string]any) string {
	for _, m := range msgs {
		if m["type"] == "error" {
			if payload, ok := m["payload"].(map[string]any); ok {
				code, _ := payload["code"].(string)
				return code
			}
		}
	}
	return ""
}

// ─── chat_send DM branch ───────────────────────────────────────────────────

func TestDM_ChatSend_ParticipantSuccess(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-send-alice")
	bob := seedMemberUser(t, database, "dm-send-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hello bob"))
	time.Sleep(100 * time.Millisecond)

	// Alice should get chat_send_ok ack.
	aliceMsgs := dmDrainAll(sendAlice)
	ack := dmFindMsgType(aliceMsgs, "chat_send_ok")
	if ack == nil {
		t.Error("Alice did not receive chat_send_ok")
	}

	// Bob should get a chat_message via SendToUser.
	bobMsgs := dmDrainAll(sendBob)
	msg := dmFindMsgType(bobMsgs, "chat_message")
	if msg == nil {
		t.Error("Bob did not receive chat_message")
	}
}

func TestDM_ChatSend_NonParticipantForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-forbid-alice")
	bob := seedMemberUser(t, database, "dm-forbid-bob")
	charlie := seedMemberUser(t, database, "dm-forbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmChatSendMsg(dmChID, "intruder"))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendCharlie)
	code := dmFindErrorCode(msgs)
	if code != "FORBIDDEN" {
		t.Errorf("non-participant chat_send: error code = %q, want FORBIDDEN", code)
	}
}

func TestDM_ChatSend_AutoReopenForRecipient(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-reopen-alice")
	bob := seedMemberUser(t, database, "dm-reopen-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	// Bob closes the DM.
	if err := database.CloseDM(bob.ID, dmChID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, 0, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	// Alice sends a message — should auto-reopen for Bob.
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hey bob"))
	time.Sleep(100 * time.Millisecond)

	// Bob should receive both a dm_channel_open and the chat_message.
	bobMsgs := dmDrainAll(sendBob)
	openMsg := dmFindMsgType(bobMsgs, "dm_channel_open")
	if openMsg == nil {
		t.Error("Bob did not receive dm_channel_open on auto-reopen")
	}
	chatMsg := dmFindMsgType(bobMsgs, "chat_message")
	if chatMsg == nil {
		t.Error("Bob did not receive chat_message after auto-reopen")
	}
}

// ─── chat_edit DM branch ────────────────────────────────────────────────────

func TestDM_ChatEdit_ParticipantCanEdit(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-edit-alice")
	bob := seedMemberUser(t, database, "dm-edit-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	// Create a message directly in the DB.
	msgID, err := database.CreateMessage(dmChID, alice.ID, "original", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	hub.Register(cAlice)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmChatEditMsg(msgID, "edited"))
	time.Sleep(100 * time.Millisecond)

	// Alice should receive the chat_edited broadcast (via broadcastToDMParticipants).
	msgs := dmDrainAll(sendAlice)
	edited := dmFindMsgType(msgs, "chat_edited")
	if edited == nil {
		t.Error("participant did not receive chat_edited for DM")
	}
}

func TestDM_ChatEdit_NonParticipantForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-editforbid-alice")
	bob := seedMemberUser(t, database, "dm-editforbid-bob")
	charlie := seedMemberUser(t, database, "dm-editforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	// Alice creates a message.
	msgID, err := database.CreateMessage(dmChID, alice.ID, "private", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmChatEditMsg(msgID, "hacked"))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendCharlie)
	code := dmFindErrorCode(msgs)
	if code != "FORBIDDEN" {
		t.Errorf("non-participant chat_edit: error code = %q, want FORBIDDEN", code)
	}
}

// ─── chat_delete DM branch ──────────────────────────────────────────────────

func TestDM_ChatDelete_ParticipantCanDeleteOwn(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-del-alice")
	bob := seedMemberUser(t, database, "dm-del-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(dmChID, alice.ID, "to delete", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmChatDeleteMsg(msgID))
	time.Sleep(100 * time.Millisecond)

	// Both participants should receive chat_deleted.
	aliceMsgs := dmDrainAll(sendAlice)
	if dmFindMsgType(aliceMsgs, "chat_deleted") == nil {
		t.Error("Alice did not receive chat_deleted")
	}
	bobMsgs := dmDrainAll(sendBob)
	if dmFindMsgType(bobMsgs, "chat_deleted") == nil {
		t.Error("Bob did not receive chat_deleted")
	}
}

func TestDM_ChatDelete_NonParticipantForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-delforbid-alice")
	bob := seedMemberUser(t, database, "dm-delforbid-bob")
	charlie := seedMemberUser(t, database, "dm-delforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(dmChID, alice.ID, "protected", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmChatDeleteMsg(msgID))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendCharlie)
	code := dmFindErrorCode(msgs)
	if code != "FORBIDDEN" {
		t.Errorf("non-participant chat_delete: error code = %q, want FORBIDDEN", code)
	}
}

func TestDM_ChatDelete_NoModeratorOverride(t *testing.T) {
	hub, database := newHandlerHub(t)
	// Even a moderator/owner cannot delete another user's message in a DM.
	alice := seedOwnerUser(t, database, "dm-nomod-alice")
	bob := seedMemberUser(t, database, "dm-nomod-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	// Bob's message.
	msgID, err := database.CreateMessage(dmChID, bob.ID, "bob says hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	hub.Register(cAlice)
	time.Sleep(20 * time.Millisecond)

	// Alice (Owner role) tries to delete Bob's message — should fail because
	// DMs disable moderator override.
	hub.HandleMessageForTest(cAlice, dmChatDeleteMsg(msgID))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendAlice)
	code := dmFindErrorCode(msgs)
	if code != "FORBIDDEN" {
		t.Errorf("DM mod override: error code = %q, want FORBIDDEN (no mod override in DMs)", code)
	}
}

// ─── typing DM branch ──────────────────────────────────────────────────────

func TestDM_Typing_ParticipantBroadcasts(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-type-alice")
	bob := seedMemberUser(t, database, "dm-type-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmTypingMsg(dmChID))
	time.Sleep(100 * time.Millisecond)

	// Bob should receive typing broadcast (type is "typing", not "typing_start").
	bobMsgs := dmDrainAll(sendBob)
	typing := dmFindMsgType(bobMsgs, "typing")
	if typing == nil {
		t.Error("Bob did not receive typing in DM")
	}
}

func TestDM_Typing_NonParticipantSilentlyDropped(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-typedrop-alice")
	bob := seedMemberUser(t, database, "dm-typedrop-bob")
	charlie := seedMemberUser(t, database, "dm-typedrop-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendCharlie := make(chan []byte, 64)
	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cCharlie)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmTypingMsg(dmChID))
	time.Sleep(100 * time.Millisecond)

	// Charlie should NOT receive an error — typing from non-participants is silently dropped.
	charlieMsgs := dmDrainAll(sendCharlie)
	if code := dmFindErrorCode(charlieMsgs); code != "" {
		t.Errorf("non-participant typing should be silently dropped, got error: %s", code)
	}

	// Alice and Bob should NOT receive typing from Charlie.
	aliceMsgs := dmDrainAll(sendAlice)
	if dmFindMsgType(aliceMsgs, "typing") != nil {
		t.Error("Alice received typing from non-participant Charlie")
	}
	bobMsgs := dmDrainAll(sendBob)
	if dmFindMsgType(bobMsgs, "typing") != nil {
		t.Error("Bob received typing from non-participant Charlie")
	}
}

// ─── channel_focus DM branch ────────────────────────────────────────────────

func TestDM_ChannelFocus_ParticipantAllowed(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-focus-alice")
	bob := seedMemberUser(t, database, "dm-focus-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, 0, sendAlice)
	hub.Register(cAlice)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmChannelFocusMsg(dmChID))
	time.Sleep(50 * time.Millisecond)

	// No error should be sent.
	msgs := dmDrainAll(sendAlice)
	if code := dmFindErrorCode(msgs); code != "" {
		t.Errorf("participant channel_focus got error: %s", code)
	}
}

func TestDM_ChannelFocus_NonParticipantRejected(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-focusforbid-alice")
	bob := seedMemberUser(t, database, "dm-focusforbid-bob")
	charlie := seedMemberUser(t, database, "dm-focusforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmChannelFocusMsg(dmChID))
	time.Sleep(50 * time.Millisecond)

	msgs := dmDrainAll(sendCharlie)
	code := dmFindErrorCode(msgs)
	if code != "FORBIDDEN" {
		t.Errorf("non-participant channel_focus: error code = %q, want FORBIDDEN", code)
	}
}

// ─── reaction DM branch ────────────────────────────────────────────────────

func TestDM_ReactionAdd_ParticipantSuccess(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-react-alice")
	bob := seedMemberUser(t, database, "dm-react-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(dmChID, alice.ID, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cBob, dmReactionAddMsg(msgID, "👍"))
	time.Sleep(100 * time.Millisecond)

	// Both participants should get reaction_update broadcast.
	aliceMsgs := dmDrainAll(sendAlice)
	if dmFindMsgType(aliceMsgs, "reaction_update") == nil {
		t.Error("Alice did not receive reaction_update in DM")
	}
	bobMsgs := dmDrainAll(sendBob)
	if dmFindMsgType(bobMsgs, "reaction_update") == nil {
		t.Error("Bob did not receive reaction_update in DM")
	}
}

func TestDM_ReactionAdd_NonParticipantError(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-reactforbid-alice")
	bob := seedMemberUser(t, database, "dm-reactforbid-bob")
	charlie := seedMemberUser(t, database, "dm-reactforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(dmChID, alice.ID, "private msg", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cCharlie, dmReactionAddMsg(msgID, "👎"))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendCharlie)
	code := dmFindErrorCode(msgs)
	// Non-participant reaction returns BAD_REQUEST (normalized to prevent IDOR info leak).
	if code != "BAD_REQUEST" {
		t.Errorf("non-participant reaction: error code = %q, want BAD_REQUEST", code)
	}
}

func TestDM_ReactionRemove_ParticipantSuccess(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-reactrm-alice")
	bob := seedMemberUser(t, database, "dm-reactrm-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(dmChID, bob.ID, "remove reaction", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendBob := make(chan []byte, 64)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cBob)
	time.Sleep(20 * time.Millisecond)

	// Add a reaction first.
	hub.HandleMessageForTest(cBob, dmReactionAddMsg(msgID, "🔥"))
	time.Sleep(50 * time.Millisecond)
	dmDrainAll(sendBob) // clear

	// Remove the reaction.
	hub.HandleMessageForTest(cBob, dmReactionRemoveMsg(msgID, "🔥"))
	time.Sleep(100 * time.Millisecond)

	msgs := dmDrainAll(sendBob)
	if dmFindMsgType(msgs, "reaction_update") == nil {
		t.Error("participant did not receive reaction_update (remove) in DM")
	}
}

// ─── DM message delivery uses SendToUser, not BroadcastToChannel ────────────

func TestDM_ChatSend_DeliveredViaSendToUser(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-delivery-alice")
	bob := seedMemberUser(t, database, "dm-delivery-bob")
	charlie := seedMemberUser(t, database, "dm-delivery-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCharlie := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	// Charlie is focused on the same channel ID (shouldn't get DM messages).
	cCharlie := ws.NewTestClientWithUser(hub, charlie, dmChID, sendCharlie)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "private to bob"))
	time.Sleep(100 * time.Millisecond)

	// Charlie should NOT receive the DM message.
	charlieMsgs := dmDrainAll(sendCharlie)
	if dmFindMsgType(charlieMsgs, "chat_message") != nil {
		t.Error("Charlie (non-participant) received DM chat_message — should be delivered only via SendToUser")
	}

	// Bob SHOULD receive it.
	bobMsgs := dmDrainAll(sendBob)
	if dmFindMsgType(bobMsgs, "chat_message") == nil {
		t.Error("Bob did not receive DM chat_message")
	}
}

// ─── Multiple DM channels isolation ─────────────────────────────────────────

func TestDM_MultipleChannels_IsolatedDelivery(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-iso-alice")
	bob := seedMemberUser(t, database, "dm-iso-bob")
	charlie := seedMemberUser(t, database, "dm-iso-charlie")

	dmAB := seedDMChannel(t, database, alice.ID, bob.ID)
	dmAC := seedDMChannel(t, database, alice.ID, charlie.ID)
	_ = dmAC // charlie's DM is separate

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	sendCharlie := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmAB, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmAB, sendBob)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, dmAC, sendCharlie)
	hub.Register(cAlice)
	hub.Register(cBob)
	hub.Register(cCharlie)
	time.Sleep(20 * time.Millisecond)

	// Alice sends to Alice-Bob DM.
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmAB, fmt.Sprintf("only for bob %d", dmAB)))
	time.Sleep(100 * time.Millisecond)

	// Charlie should NOT get this message.
	charlieMsgs := dmDrainAll(sendCharlie)
	if dmFindMsgType(charlieMsgs, "chat_message") != nil {
		t.Error("Charlie received message from Alice-Bob DM")
	}
}
