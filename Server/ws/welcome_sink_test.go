package ws_test

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

func TestWelcomeRow_ChannelSequencedNoMentionPlusActivity(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "lobby")
	joiner := seedTestUser(t, database, "newcomer")
	reader := seedTestUser(t, database, "reader")
	away := seedTestUser(t, database, "away")

	readerSend := make(chan []byte, 8)
	awaySend := make(chan []byte, 8)
	hub.Register(ws.NewTestClientWithChannel(hub, reader, chID, readerSend))
	awayClient := ws.NewTestClientWithChannel(hub, away, 999, awaySend)
	hub.Register(awayClient)
	waitRegistered(t, hub, awayClient)

	res := &service.WelcomeResult{
		Row: &db.WelcomeRow{
			MessageID: 601, ChannelID: chID, UserID: joiner,
			Content: "newcomer joined the server.", Timestamp: "2026-10-24 10:00:00",
		},
		Author:     &db.User{ID: joiner, Username: "newcomer"},
		AuthorRole: "Member",
	}
	hub.WelcomeRow(context.Background(), res)

	select {
	case raw := <-readerSend:
		f := decodePinFrame(t, raw)
		if f.Type != "chat_message" || f.Seq == 0 {
			t.Errorf("frame type = %q seq = %d, want a sequenced chat_message", f.Type, f.Seq)
		}
		p := f.Payload
		if p.ID != 601 || p.ChannelID != chID || p.Kind != "member_join" || p.User.ID != joiner ||
			p.Content != "newcomer joined the server." {
			t.Errorf("payload = %+v", p)
		}
		if p.ReplyTo != nil || p.Referenced != nil {
			t.Errorf("reply_to = %v referenced = %v, want both null", p.ReplyTo, p.Referenced)
		}
		if p.Mentions == nil || len(p.Mentions) != 0 || p.MentionsEveryone {
			t.Errorf("mentions = %v everyone = %v, want [] and false", p.Mentions, p.MentionsEveryone)
		}
	case <-time.After(time.Second):
		t.Fatal("channel reader did not receive the welcome row")
	}

	// A reader focused elsewhere gets the channel_activity hint, never the row.
	var sawActivity bool
	timer := time.After(500 * time.Millisecond)
collect:
	for {
		select {
		case raw := <-awaySend:
			switch decodePinFrame(t, raw).Type {
			case "chat_message":
				t.Errorf("client focused on another channel received the welcome row")
			case "channel_activity":
				sawActivity = true
			}
		case <-timer:
			break collect
		}
	}
	if !sawActivity {
		t.Errorf("client focused elsewhere got no channel_activity note")
	}

	var held int
	for _, frame := range hub.ReplayBuffer().AllFramesForTest() {
		if bytes.Contains(frame, []byte(`"member_join"`)) {
			held++
		}
	}
	if held != 1 {
		t.Errorf("replay ring holds %d welcome rows, want 1", held)
	}
}

func TestWelcomeRow_NilOrEmptyResultSendsNothing(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.WelcomeRow(context.Background(), nil)
	f.hub.WelcomeRow(context.Background(), &service.WelcomeResult{})
	if frames := callFrames(f.aliceSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("got %d frames, want none", len(frames))
	}
}
