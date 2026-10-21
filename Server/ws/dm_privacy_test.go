package ws_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// WP 6.8c over the wire: a recipient with "Allow DMs" off refuses an untrusted
// 1:1 counterpart on every DMBlocked sink with the same code and text a block
// produces. Fixture: alice and bob share an untrusted 1:1 DM that already
// holds one message from alice.

type dmPrivacyWS struct {
	hub       *ws.Hub
	database  *db.DB
	alice     *db.User
	bob       *db.User
	dmID      int64
	msgID     int64
	sendAlice chan []byte
	sendBob   chan []byte
	cAlice    *ws.Client
}

// newDMPrivacyHub is a hub with the full service bundle (chat, rings) and a
// stub SFU (voice join).
func newDMPrivacyHub(t *testing.T) (*ws.Hub, *db.DB) {
	t.Helper()
	database := openHandlerDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubWith(t, ws.HubOptions{
		DB: database, Limiter: limiter, Services: service.New(database, limiter), LiveKit: healthyLiveKitClient(t),
	})
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	return hub, database
}

func newDMPrivacyWS(t *testing.T) *dmPrivacyWS {
	t.Helper()
	hub, database := newDMPrivacyHub(t)
	f := &dmPrivacyWS{hub: hub, database: database}
	f.alice = seedMemberUser(t, database, "dmpriv-alice")
	f.bob = seedMemberUser(t, database, "dmpriv-bob")
	f.dmID = untrustedDMChannel(t, database, f.alice.ID, f.bob.ID)
	var err error
	if f.msgID, err = database.CreateMessage(context.Background(), f.dmID, f.alice.ID, "hello", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	f.sendAlice = make(chan []byte, 64)
	f.sendBob = make(chan []byte, 64)
	f.cAlice = ws.NewTestClientWithUser(hub, f.alice, f.dmID, f.sendAlice)
	cBob := ws.NewTestClientWithUser(hub, f.bob, f.dmID, f.sendBob)
	hub.Register(f.cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)
	waitRegistered(t, hub, f.cAlice)
	return f
}

func (f *dmPrivacyWS) setAllowDMs(t *testing.T, userID int64, allow bool) {
	t.Helper()
	if err := f.database.SetUserPrivacy(context.Background(), userID, db.UserPrivacy{AllowMemberDMs: allow, MessageRequests: true}); err != nil {
		t.Fatalf("SetUserPrivacy: %v", err)
	}
}

// refusal sends frame as alice and returns the first error frame as
// "CODE: message", or "" when none arrived.
func (f *dmPrivacyWS) refusal(frame []byte) string {
	f.hub.HandleMessageForTest(f.cAlice, frame)
	for _, m := range dmCollectAll(f.sendAlice, absenceWindow) {
		if m["type"] != "error" {
			continue
		}
		p, _ := m["payload"].(map[string]any)
		code, _ := p["code"].(string)
		msg, _ := p["message"].(string)
		return code + ": " + msg
	}
	return ""
}

func dmPrivacyFrames(f *dmPrivacyWS) map[string][]byte {
	ringFrame := callMsg("call_ring", f.dmID)
	return map[string][]byte{
		"chat_send":    dmChatSendMsg(f.dmID, "again"),
		"chat_edit":    dmChatEditMsg(f.msgID, "edited"),
		"reaction_add": dmReactionAddMsg(f.msgID, "👍"),
		"call_ring":    ringFrame,
		"voice_join":   voiceJoinMsg(f.dmID),
	}
}

// TestDMPrivacy_UntrustedSendRefused_NoFrameToRecipient: a refused first send
// writes no message and the recipient hears nothing, not even a request.
func TestDMPrivacy_UntrustedSendRefused_NoFrameToRecipient(t *testing.T) {
	f := newDMPrivacyWS(t)
	f.setAllowDMs(t, f.bob.ID, false)

	if got := f.refusal(dmChatSendMsg(f.dmID, "hi")); !strings.HasPrefix(got, "FORBIDDEN: ") {
		t.Fatalf("chat_send refusal = %q, want FORBIDDEN", got)
	}
	if frames := dmCollectAll(f.sendBob, absenceWindow); len(frames) != 0 {
		t.Errorf("recipient received %d frame(s) from a refused send: %v", len(frames), frames)
	}
	var n int
	if err := f.database.QueryRowContext(context.Background(),
		`SELECT (SELECT COUNT(*) FROM messages WHERE channel_id = ?) + (SELECT COUNT(*) FROM message_requests)`, f.dmID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 { // only the seeded message
		t.Errorf("messages+requests = %d, want 1 (the seeded message)", n)
	}
}

// TestDMPrivacy_EditReactPinRingVoiceRefused: every wire sink answers FORBIDDEN
// (pin is a REST/service sink, covered in service/dm_privacy_test.go).
func TestDMPrivacy_EditReactPinRingVoiceRefused(t *testing.T) {
	for _, sink := range []string{"chat_send", "chat_edit", "reaction_add", "call_ring", "voice_join"} {
		t.Run(sink, func(t *testing.T) {
			f := newDMPrivacyWS(t)
			f.setAllowDMs(t, f.bob.ID, false)
			if sink == "call_ring" {
				ws.SetVoiceChIDForTest(f.cAlice, f.dmID) // a ring comes from inside the call
			}
			got := f.refusal(dmPrivacyFrames(f)[sink])
			if !strings.HasPrefix(got, "FORBIDDEN: ") {
				t.Fatalf("%s refusal = %q, want FORBIDDEN", sink, got)
			}
			if frames := dmCollectAll(f.sendBob, absenceWindow); dmFindMsgType(frames, "call_incoming") != nil ||
				dmFindMsgType(frames, "chat_edited") != nil || dmFindMsgType(frames, "reaction_added") != nil {
				t.Errorf("recipient received a frame from the refused %s: %v", sink, frames)
			}
		})
	}

	t.Run("voice_token_refresh", func(t *testing.T) {
		hub, database := newVoiceHub(t)
		alice := seedMemberUser(t, database, "dmprivrefresh-alice")
		bob := seedMemberUser(t, database, "dmprivrefresh-bob")
		dmID := untrustedDMChannel(t, database, alice.ID, bob.ID)
		send := make(chan []byte, 32)
		c := ws.NewTestClientWithUser(hub, alice, 0, send)
		hub.Register(c)
		waitRegistered(t, hub, c)

		hub.HandleMessageForTest(c, voiceJoinMsg(dmID))
		if !hasVoiceToken(t, drainChanTimeout(send, 50*time.Millisecond)) {
			t.Fatal("join before the setting flipped did not mint a token")
		}
		if err := database.SetUserPrivacy(context.Background(), bob.ID, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
			t.Fatalf("SetUserPrivacy: %v", err)
		}
		hub.HandleMessageForTest(c, voiceTokenRefreshMsg())
		assertNoVoiceToken(t, drainChanTimeout(send, 200*time.Millisecond))
	})

}

// TestDMPrivacy_RefusalMatchesBlock: per sink, the refusal under "DMs off" has
// the same code and text as "blocked by the recipient" and "sender blocked the
// recipient".
func TestDMPrivacy_RefusalMatchesBlock(t *testing.T) {
	scenarios := []struct {
		name  string
		setup func(t *testing.T, f *dmPrivacyWS)
	}{
		{"privacy_off", func(t *testing.T, f *dmPrivacyWS) { f.setAllowDMs(t, f.bob.ID, false) }},
		{"blocked_by_recipient", func(t *testing.T, f *dmPrivacyWS) {
			if err := f.database.BlockUser(context.Background(), f.bob.ID, f.alice.ID); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
		{"sender_blocked_recipient", func(t *testing.T, f *dmPrivacyWS) {
			if err := f.database.BlockUser(context.Background(), f.alice.ID, f.bob.ID); err != nil {
				t.Fatalf("BlockUser: %v", err)
			}
		}},
	}
	for _, sink := range []string{"chat_send", "chat_edit", "reaction_add", "call_ring", "voice_join"} {
		t.Run(sink, func(t *testing.T) {
			var base string
			for i, sc := range scenarios {
				f := newDMPrivacyWS(t)
				sc.setup(t, f)
				if sink == "call_ring" {
					ws.SetVoiceChIDForTest(f.cAlice, f.dmID)
				}
				got := f.refusal(dmPrivacyFrames(f)[sink])
				if !strings.HasPrefix(got, "FORBIDDEN: ") {
					t.Fatalf("%s/%s refusal = %q, want FORBIDDEN", sink, sc.name, got)
				}
				if i == 0 {
					base = got
					continue
				}
				if got != base {
					t.Errorf("%s: %s = %q, privacy_off = %q; want identical", sink, sc.name, got, base)
				}
			}
			if sink != "voice_join" && !strings.Contains(base, "you can't message this user") {
				t.Errorf("%s refusal %q is not the neutral text", sink, base)
			}
			if sink == "voice_join" && !strings.Contains(base, "cannot join this call") {
				t.Errorf("%s refusal %q is not the neutral text", sink, base)
			}
		})
	}
}

// TestDMPrivacy_TrustedSendStillDelivers: the same recipient setting does not
// stop a trusted counterpart.
func TestDMPrivacy_TrustedSendStillDelivers(t *testing.T) {
	f := newDMPrivacyWS(t)
	f.setAllowDMs(t, f.bob.ID, false)
	if err := f.database.TrustSender(context.Background(), f.bob.ID, f.alice.ID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	f.hub.HandleMessageForTest(f.cAlice, dmChatSendMsg(f.dmID, "hi"))
	if dmWaitMsgType(f.sendAlice, "chat_send_ok", waitTimeout) == nil {
		t.Fatal("trusted sender did not get chat_send_ok")
	}
}

// TestDMPrivacy_GroupDMUnaffected: a group member with DMs off still receives
// and sends in the group.
func TestDMPrivacy_GroupDMUnaffected(t *testing.T) {
	hub, database := newDMPrivacyHub(t)
	alice := seedMemberUser(t, database, "dmprivgrp-alice")
	bob := seedMemberUser(t, database, "dmprivgrp-bob")
	carol := seedMemberUser(t, database, "dmprivgrp-carol")
	chID := seedGroupDM(t, database, "Room", alice.ID, bob.ID, carol.ID)
	for _, u := range []*db.User{bob, carol} {
		if err := database.SetUserPrivacy(context.Background(), u.ID, db.UserPrivacy{AllowMemberDMs: false, MessageRequests: true}); err != nil {
			t.Fatalf("SetUserPrivacy: %v", err)
		}
	}

	sendAlice := make(chan []byte, 64)
	sendBob := make(chan []byte, 64)
	cAlice := ws.NewTestClientWithUser(hub, alice, chID, sendAlice)
	cBob := ws.NewTestClientWithUser(hub, bob, chID, sendBob)
	hub.Register(cAlice)
	hub.Register(cBob)
	waitRegistered(t, hub, cBob)

	hub.HandleMessageForTest(cAlice, dmChatSendMsg(chID, "to the group"))
	if dmWaitMsgType(sendBob, "chat_message", waitTimeout) == nil {
		t.Fatal("group member with DMs off did not receive the group message")
	}
	hub.HandleMessageForTest(cBob, dmChatSendMsg(chID, "reply"))
	if dmWaitMsgType(sendAlice, "chat_message", waitTimeout) == nil {
		t.Fatal("group member with DMs off could not send into the group")
	}
}
