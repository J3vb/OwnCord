package ws_test

// dm_request_test.go covers B5-6's live-delivery half: an untrusted
// recipient hears nothing from the channel but dm_request (message, typing,
// reaction), acceptance opens the channel and resumes ordinary delivery, and
// a transition made elsewhere (there is no ws command for it — accept/
// ignore/delete/block are REST-only, api/dm_request_handler_test.go) still
// reaches the recipient's live connection. The state machine and the
// decision-5 sender property are service/message_request_test.go's and
// api/dm_request_handler_test.go's jobs; this file only has sockets.

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// newDMRequestTestHub is newHandlerHub (handlers_test.go) plus the
// *service.Services handle: these tests decide requests directly through
// MessageRequestService (there is no ws command for it), so they need the
// service, not just the hub.
func newDMRequestTestHub(t *testing.T) (*ws.Hub, *db.DB, *service.Services) {
	t.Helper()
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database, svc
}

// untrustedDMChannel creates a one-to-one DM channel with NO trust row in
// either direction — a genuine stranger pair, unlike seedDMChannel.
func untrustedDMChannel(t *testing.T, database *db.DB, user1ID, user2ID int64) int64 {
	t.Helper()
	ch, _, err := database.GetOrCreateDMChannel(context.Background(), user1ID, user2ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	return ch.ID
}

// silenceWindow is how long these tests wait to prove nothing else arrives.
// Short enough to keep the suite fast, long enough that a real frame sent
// immediately after the one being tolerated is not missed by a race.
const silenceWindow = 150 * time.Millisecond

// TestMessageRequest_UntrustedRecipientHearsNothingButTheRequest: alice, a
// stranger to bob, sends a message, then types, then reacts to it — bob's
// socket sees exactly one dm_request (from the send) and nothing else at all
// from any of the three.
func TestMessageRequest_UntrustedRecipientHearsNothingButTheRequest(t *testing.T) {
	hub, database, _ := newDMRequestTestHub(t)
	alice := seedOwnerUser(t, database, "mr-untrusted-alice")
	bob := seedMemberUser(t, database, "mr-untrusted-bob")
	dmChID := untrustedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	// Message: alice's first send. Bob gets exactly one dm_request.
	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hi stranger"))
	if dmWaitMsgType(sendAlice, "chat_send_ok", waitTimeout) == nil {
		t.Fatal("alice did not receive chat_send_ok")
	}
	if dmWaitMsgType(sendAlice, "chat_message", waitTimeout) == nil {
		t.Fatal("alice did not receive chat_message")
	}
	msgs := dmCollectAll(sendBob, silenceWindow)
	var dmRequests, other int
	msgID := int64(0)
	for _, m := range msgs {
		if m["type"] == "dm_request" {
			dmRequests++
			if payload, ok := m["payload"].(map[string]any); ok {
				if state, _ := payload["state"].(string); state != "pending" {
					t.Errorf("dm_request state = %v, want pending", state)
				}
				if preview, ok := payload["preview"].(map[string]any); ok {
					if mid, ok := preview["message_id"].(float64); ok {
						msgID = int64(mid)
					}
				} else {
					t.Error("dm_request on creation carries no preview")
				}
			}
			continue
		}
		if m["type"] == "pong" {
			continue // no ping sent here, but keep the check strict elsewhere
		}
		other++
		t.Errorf("bob received an unexpected frame from the send: %v", m)
	}
	if dmRequests != 1 {
		t.Fatalf("bob received %d dm_request frames from the send, want exactly 1", dmRequests)
	}
	if other != 0 {
		t.Fatalf("bob received %d non-dm_request frames from the send, want 0", other)
	}

	// Typing: bob must hear nothing.
	hub.HandleMessageForTest(cAlice, dmTypingMsg(dmChID))
	if got := dmCollectAll(sendBob, silenceWindow); len(got) != 0 {
		t.Errorf("bob received %v from alice's typing indicator, want silence", got)
	}

	// Reaction: alice reacts to her own message; bob must hear nothing.
	if msgID == 0 {
		t.Fatal("could not recover the held message's id from the dm_request preview")
	}
	hub.HandleMessageForTest(cAlice, dmReactionAddMsg(msgID, "x"))
	if got := dmCollectAll(sendBob, silenceWindow); len(got) != 0 {
		t.Errorf("bob received %v from alice's reaction, want silence", got)
	}
}

// TestMessageRequest_AcceptOpensAndDelivers: after bob accepts (decided
// through the service directly — accept is a REST-only route), bob gets
// dm_channel_open, and alice's next message reaches bob live as
// chat_message, exactly like an ordinary trusted DM.
func TestMessageRequest_AcceptOpensAndDelivers(t *testing.T) {
	hub, database, svc := newDMRequestTestHub(t)
	alice := seedOwnerUser(t, database, "mr-accept-alice")
	bob := seedMemberUser(t, database, "mr-accept-bob")
	dmChID := untrustedDMChannel(t, database, alice.ID, bob.ID)

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, dmChID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	sendResult, err := svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: dmChID, UserID: alice.ID, Username: alice.Username, Content: "hi stranger",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(sendResult.RequestCreatedFor) != 1 {
		t.Fatalf("RequestCreatedFor = %v, want one", sendResult.RequestCreatedFor)
	}
	dmDrainAll(sendAlice)
	dmDrainAll(sendBob)

	if _, err := svc.MessageRequests.Accept(context.Background(), bob.ID, sendResult.RequestCreatedFor[0].ID); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "now you can see me"))
	if dmWaitMsgType(sendAlice, "chat_send_ok", waitTimeout) == nil {
		t.Fatal("alice did not receive chat_send_ok")
	}
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Fatal("bob did not receive chat_message after accepting")
	}
}

// normalizeSenderFrame strips the volatile fields (ids, timestamps) from a
// decoded chat_send_ok/chat_message envelope so two sends into different
// channels, at different times, compare on shape alone.
func normalizeSenderFrame(env map[string]any) map[string]any {
	out := map[string]any{"type": env["type"]}
	payload, ok := env["payload"].(map[string]any)
	if !ok {
		return out
	}
	clean := map[string]any{}
	for k, v := range payload {
		switch k {
		case "id", "message_id", "channel_id", "timestamp":
			continue
		default:
			clean[k] = v
		}
	}
	out["payload"] = clean
	return out
}

// TestMessageRequest_SenderViewIsByteIdentical: decision 5's property, read
// from the wire — alice's own chat_send_ok and chat_message frames do not
// vary with the recipient's decision (pending, ignored, deleted) or with a
// trusted control, once volatile ids/timestamps are normalised.
func TestMessageRequest_SenderViewIsByteIdentical(t *testing.T) {
	hub, database, _ := newDMRequestTestHub(t)
	alice := seedOwnerUser(t, database, "mr-identical-alice")

	sendAndCapture := func(recipientName string, preTrust bool, decide func(reqID int64)) []map[string]any {
		t.Helper()
		recipient := seedMemberUser(t, database, recipientName)
		var dmChID int64
		if preTrust {
			dmChID = seedDMChannel(t, database, alice.ID, recipient.ID) // trusted control
		} else {
			dmChID = untrustedDMChannel(t, database, alice.ID, recipient.ID)
		}

		sendAlice := make(chan []byte, 64)
		cAlice := ws.NewTestClientWithUser(hub, alice, dmChID, sendAlice)
		hub.Register(cAlice)
		waitRegistered(t, hub, cAlice)

		hub.HandleMessageForTest(cAlice, dmChatSendMsg(dmChID, "hello"))
		ok := dmWaitMsgType(sendAlice, "chat_send_ok", waitTimeout)
		msg := dmWaitMsgType(sendAlice, "chat_message", waitTimeout)
		if ok == nil || msg == nil {
			t.Fatalf("%s: alice did not receive both chat_send_ok and chat_message", recipientName)
		}

		if decide != nil {
			reqID, err := database.GetMessageRequestByPair(context.Background(), alice.ID, recipient.ID)
			if err != nil {
				t.Fatalf("%s: GetMessageRequestByPair: %v", recipientName, err)
			}
			decide(reqID.ID)
		}
		return []map[string]any{normalizeSenderFrame(ok), normalizeSenderFrame(msg)}
	}

	pending := sendAndCapture("mr-identical-bob", false, nil)
	ignored := sendAndCapture("mr-identical-carol", false, func(id int64) {
		if _, err := database.TransitionMessageRequest(context.Background(), id, mustRecipientID(t, database, "mr-identical-carol"), "ignored"); err != nil {
			t.Fatalf("TransitionMessageRequest: %v", err)
		}
	})
	deleted := sendAndCapture("mr-identical-dave", false, func(id int64) {
		if _, err := database.TransitionMessageRequest(context.Background(), id, mustRecipientID(t, database, "mr-identical-dave"), "deleted"); err != nil {
			t.Fatalf("TransitionMessageRequest: %v", err)
		}
	})
	trusted := sendAndCapture("mr-identical-eve", true, nil)

	want, err := json.Marshal(pending)
	if err != nil {
		t.Fatalf("marshal pending: %v", err)
	}
	for name, got := range map[string][]map[string]any{"ignored": ignored, "deleted": deleted, "trusted": trusted} {
		gotJSON, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		if !bytes.Equal(gotJSON, want) {
			t.Errorf("%s sender frames differ from pending's:\npending: %s\n%s:      %s", name, want, name, gotJSON)
		}
	}
}

func mustRecipientID(t *testing.T, database *db.DB, username string) int64 {
	t.Helper()
	u, err := database.GetUserByUsername(context.Background(), username)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%q): %v", username, err)
	}
	return u.ID
}
