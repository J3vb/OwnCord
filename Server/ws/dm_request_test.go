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
	"strings"
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

// normalizeSenderFrame recursively replaces every volatile field (a key
// named "id" or ending in "_id", or a timestamp — "timestamp", "seq", or a
// key ending in "_at") in a decoded envelope with a type-tagged placeholder,
// leaving every OTHER field exactly as sent (Codex P2-7 — the old version
// dropped "channel_id" and "message_id" outright, which could hide a real
// divergence in either). channel_id is included among the volatile keys
// here (unlike the epoch-1 fixture normaliser, which pins it deliberately
// for a single fixed database): every capture below sends into a distinct
// per-recipient DM channel, so the id itself is expected to differ and only
// its type is worth comparing.
func normalizeSenderFrame(env map[string]any) map[string]any {
	out, _ := normalizeSenderValue(env).(map[string]any)
	return out
}

func normalizeSenderValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if isVolatileSenderKey(k) {
				out[k] = "<" + senderValueType(val) + ">"
				continue
			}
			out[k] = normalizeSenderValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i := range t {
			out[i] = normalizeSenderValue(t[i])
		}
		return out
	default:
		return v
	}
}

func isVolatileSenderKey(key string) bool {
	switch {
	case key == "id", strings.HasSuffix(key, "_id"):
		return true
	case key == "timestamp", key == "seq", strings.HasSuffix(key, "_at"):
		return true
	default:
		return false
	}
}

func senderValueType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case float64, json.Number:
		return "number"
	case bool:
		return "bool"
	default:
		return "other"
	}
}

// TestMessageRequest_SenderViewIsByteIdentical: decision 5's property, read
// from the wire — alice's own chat_send_ok and chat_message frames do not
// vary with the recipient's decision (pending, ignored, deleted) or with a
// trusted control, once volatile ids/timestamps are normalised.
//
// Codex P2-7: the measured send for ignored/deleted is a RESEND made AFTER
// the recipient's decision, not the original creating send — the property
// under test is "does a send while the request sits ignored/deleted still
// look normal", and the original implementation compared the one send that
// happens before any decision exists across all four cases, which cannot
// distinguish the states at all.
func TestMessageRequest_SenderViewIsByteIdentical(t *testing.T) {
	hub, database, _ := newDMRequestTestHub(t)
	alice := seedOwnerUser(t, database, "mr-identical-alice")

	// capture sends the MEASURED message on dmChID and returns alice's own
	// chat_send_ok + chat_message frames, normalised.
	capture := func(recipientName string, dmChID int64) []map[string]any {
		t.Helper()
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
		return []map[string]any{normalizeSenderFrame(ok), normalizeSenderFrame(msg)}
	}

	// pending: the very first send IS the measured one — it is what creates
	// the pending request in the first place.
	bob := seedMemberUser(t, database, "mr-identical-bob")
	pending := capture("mr-identical-bob", untrustedDMChannel(t, database, alice.ID, bob.ID))

	// ignored / deleted: an unmeasured setup send creates the request, the
	// recipient decides, and only THEN does the measured resend run.
	decideThenCapture := func(recipientName, newState string) []map[string]any {
		t.Helper()
		recipient := seedMemberUser(t, database, recipientName)
		dmChID := untrustedDMChannel(t, database, alice.ID, recipient.ID)

		setup := make(chan []byte, 64)
		cSetup := ws.NewTestClientWithUser(hub, alice, dmChID, setup)
		hub.Register(cSetup)
		waitRegistered(t, hub, cSetup)
		hub.HandleMessageForTest(cSetup, dmChatSendMsg(dmChID, "setup"))
		if dmWaitMsgType(setup, "chat_send_ok", waitTimeout) == nil {
			t.Fatalf("%s: setup send failed", recipientName)
		}
		dmWaitMsgType(setup, "chat_message", waitTimeout)

		reqRow, err := database.GetMessageRequestByPair(context.Background(), alice.ID, recipient.ID)
		if err != nil {
			t.Fatalf("%s: GetMessageRequestByPair: %v", recipientName, err)
		}
		if _, err := database.TransitionMessageRequest(context.Background(), reqRow.ID, recipient.ID, newState); err != nil {
			t.Fatalf("%s: TransitionMessageRequest: %v", recipientName, err)
		}

		return capture(recipientName, dmChID)
	}
	ignored := decideThenCapture("mr-identical-carol", "ignored")
	deleted := decideThenCapture("mr-identical-dave", "deleted")

	// Trusted control: pre-trusted, so — like the pending case — the first
	// (only) send is the measured one.
	eve := seedMemberUser(t, database, "mr-identical-eve")
	trusted := capture("mr-identical-eve", seedDMChannel(t, database, alice.ID, eve.ID))

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
