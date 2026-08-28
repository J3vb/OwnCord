package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── DM test helpers ────────────────────────────────────────────────────────

// seedDMChannel creates a DM channel between two users and returns the channel ID.
func seedDMChannel(t *testing.T, database *db.DB, user1ID, user2ID int64) int64 {
	t.Helper()
	ch, _, err := database.GetOrCreateDMChannel(context.Background(), user1ID, user2ID)
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

// dmWaitMsgType blocks until a message with the given type arrives on ch,
// returning its envelope, or returns nil when the timeout expires.
func dmWaitMsgType(ch <-chan []byte, msgType string, timeout time.Duration) map[string]any {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case raw := <-ch:
			var env map[string]any
			if err := json.Unmarshal(raw, &env); err != nil {
				continue
			}
			if env["type"] == msgType {
				return env
			}
		case <-timer.C:
			return nil
		}
	}
}

// dmCollectAll reads messages for the full window d and returns the decoded
// envelopes. Use for absence assertions — the window always elapses.
func dmCollectAll(ch <-chan []byte, d time.Duration) []map[string]any {
	var result []map[string]any
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case raw := <-ch:
			var env map[string]any
			if err := json.Unmarshal(raw, &env); err == nil {
				result = append(result, env)
			}
		case <-timer.C:
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
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hello bob"))

	// Alice should get chat_send_ok ack.
	if dmWaitMsgType(sendAlice, "chat_send_ok", waitTimeout) == nil {
		t.Error("Alice did not receive chat_send_ok")
	}

	// Bob should get a chat_message via SendToUser.
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Error("Bob did not receive chat_message")
	}
}

func TestDM_ChatSend_SequencedAndReplayBuffered(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-seq-alice")
	bob := seedMemberUser(t, database, "dm-seq-bob")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 128)
	sendBob := make(chan []byte, 128)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "m1"))
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "m2"))
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "m3"))

	chat := dmWaitMsgType(sendBob, "chat_message", waitTimeout)
	if chat == nil {
		t.Fatal("Bob did not receive any DM chat_message")
	}
	if _, ok := chat["seq"]; !ok {
		t.Fatal("DM chat_message is missing seq")
	}

	oldest := hub.ReplayBuffer().OldestSeq()
	if oldest == 0 {
		t.Fatal("replay buffer did not record DM events (oldest seq is 0)")
	}

	replayed := hub.ReplayBuffer().EventsSinceFiltered(oldest+1, map[int64]bool{dmChID: true})
	if len(replayed) == 0 {
		t.Fatal("expected DM replay events after oldest+1, got none")
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
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cCharlie, dmChatSendMsg(dmChID, "intruder"))

	// Error replies are sent synchronously by handleMessage — already buffered.
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
	if err := database.CloseDM(context.Background(), bob.ID, dmChID); err != nil {
		t.Fatalf("CloseDM: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, 0, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	// Alice sends a message — should auto-reopen for Bob.
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hey bob"))

	// Bob should receive both a dm_channel_open and the chat_message.
	if dmWaitMsgType(sendBob, "dm_channel_open", waitTimeout) == nil {
		t.Error("Bob did not receive dm_channel_open on auto-reopen")
	}
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
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
	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "original", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	hub.HandleMessageForTest(cAlice, dmChatEditMsg(msgID, "edited"))

	// Alice should receive the chat_edited broadcast (via the sequenced DM event path).
	if dmWaitMsgType(sendAlice, "chat_edited", waitTimeout) == nil {
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
	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "private", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cCharlie, dmChatEditMsg(msgID, "hacked"))

	// Error replies are sent synchronously by handleMessage — already buffered.
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

	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "to delete", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmChatDeleteMsg(msgID))

	// Both participants should receive chat_deleted.
	if dmWaitMsgType(sendAlice, "chat_deleted", waitTimeout) == nil {
		t.Error("Alice did not receive chat_deleted")
	}
	if dmWaitMsgType(sendBob, "chat_deleted", waitTimeout) == nil {
		t.Error("Bob did not receive chat_deleted")
	}
}

func TestDM_ChatDelete_NonParticipantForbidden(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-delforbid-alice")
	bob := seedMemberUser(t, database, "dm-delforbid-bob")
	charlie := seedMemberUser(t, database, "dm-delforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "protected", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cCharlie, dmChatDeleteMsg(msgID))

	// Error replies are sent synchronously by handleMessage — already buffered.
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
	msgID, err := database.CreateMessage(context.Background(), dmChID, bob.ID, "bob says hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	hub.Register(cAlice)
	waitRegistered(t, hub, cAlice)

	// Alice (Owner role) tries to delete Bob's message — should fail because
	// DMs disable moderator override.
	hub.HandleMessageForTest(cAlice, dmChatDeleteMsg(msgID))

	// Error replies are sent synchronously by handleMessage — already buffered.
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
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmTypingMsg(dmChID))

	// Bob should receive typing broadcast (type is "typing", not "typing_start").
	if dmWaitMsgType(sendBob, "typing", waitTimeout) == nil {
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
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cCharlie, dmTypingMsg(dmChID))

	// Alice and Bob should NOT receive typing from Charlie. The bounded window
	// on Alice's channel doubles as the settle time for Bob's (a wrongly routed
	// typing broadcast would be fanned out to both in the same delivery pass).
	aliceMsgs := dmCollectAll(sendAlice, 100*time.Millisecond)
	if dmFindMsgType(aliceMsgs, "typing") != nil {
		t.Error("Alice received typing from non-participant Charlie")
	}
	bobMsgs := dmDrainAll(sendBob)
	if dmFindMsgType(bobMsgs, "typing") != nil {
		t.Error("Bob received typing from non-participant Charlie")
	}

	// Charlie should NOT receive an error — typing from non-participants is
	// silently dropped (error replies would have been sent synchronously).
	charlieMsgs := dmDrainAll(sendCharlie)
	if code := dmFindErrorCode(charlieMsgs); code != "" {
		t.Errorf("non-participant typing should be silently dropped, got error: %s", code)
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
	waitRegistered(t, hub, cAlice)

	hub.HandleMessageForTest(cAlice, dmChannelFocusMsg(dmChID))

	// No error should be sent (error replies are synchronous — already buffered).
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
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cCharlie, dmChannelFocusMsg(dmChID))

	// Error replies are sent synchronously by handleMessage — already buffered.
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

	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "react to me", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cBob, dmReactionAddMsg(msgID, "👍"))

	// Both participants should get reaction_update broadcast.
	if dmWaitMsgType(sendAlice, "reaction_update", waitTimeout) == nil {
		t.Error("Alice did not receive reaction_update in DM")
	}
	if dmWaitMsgType(sendBob, "reaction_update", waitTimeout) == nil {
		t.Error("Bob did not receive reaction_update in DM")
	}
}

func TestDM_ReactionAdd_NonParticipantError(t *testing.T) {
	hub, database := newHandlerHub(t)
	alice := seedOwnerUser(t, database, "dm-reactforbid-alice")
	bob := seedMemberUser(t, database, "dm-reactforbid-bob")
	charlie := seedMemberUser(t, database, "dm-reactforbid-charlie")
	dmChID := seedDMChannel(t, database, alice.ID, bob.ID)

	msgID, err := database.CreateMessage(context.Background(), dmChID, alice.ID, "private msg", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendCharlie := make(chan []byte, 64)
	cCharlie := ws.NewTestClientWithUser(hub, charlie, 0, sendCharlie)
	hub.Register(cCharlie)
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cCharlie, dmReactionAddMsg(msgID, "👎"))

	// Error replies are sent synchronously by handleMessage — already buffered.
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

	msgID, err := database.CreateMessage(context.Background(), dmChID, bob.ID, "remove reaction", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	sendBob := make(chan []byte, 64)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	// Add a reaction first and consume its reaction_update broadcast.
	hub.HandleMessageForTest(cBob, dmReactionAddMsg(msgID, "🔥"))
	if dmWaitMsgType(sendBob, "reaction_update", waitTimeout) == nil {
		t.Fatal("participant did not receive reaction_update (add) in DM")
	}

	// Remove the reaction.
	hub.HandleMessageForTest(cBob, dmReactionRemoveMsg(msgID, "🔥"))

	if dmWaitMsgType(sendBob, "reaction_update", waitTimeout) == nil {
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
	waitRegistered(t, hub, cCharlie)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "private to bob"))

	// Bob SHOULD receive it.
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Error("Bob did not receive DM chat_message")
	}

	// Charlie should NOT receive the DM message — bounded absence window after
	// Bob's copy has already been delivered.
	charlieMsgs := dmCollectAll(sendCharlie, 50*time.Millisecond)
	if dmFindMsgType(charlieMsgs, "chat_message") != nil {
		t.Error("Charlie (non-participant) received DM chat_message — should be delivered only via SendToUser")
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
	waitRegistered(t, hub, cCharlie)

	// Alice sends to Alice-Bob DM.
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmAB, fmt.Sprintf("only for bob %d", dmAB)))

	// Bob's copy arriving proves delivery completed; then Charlie gets a
	// bounded absence window.
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Fatal("Bob did not receive the Alice-Bob DM message")
	}

	// Charlie should NOT get this message.
	charlieMsgs := dmCollectAll(sendCharlie, 50*time.Millisecond)
	if dmFindMsgType(charlieMsgs, "chat_message") != nil {
		t.Error("Charlie received message from Alice-Bob DM")
	}
}
