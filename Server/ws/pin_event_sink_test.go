package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

type pinFrame struct {
	Seq     uint64 `json:"seq"`
	Type    string `json:"type"`
	Payload struct {
		ID               int64   `json:"id"`
		ChannelID        int64   `json:"channel_id"`
		Kind             string  `json:"kind"`
		Content          string  `json:"content"`
		ReplyTo          *int64  `json:"reply_to"`
		Mentions         []int64 `json:"mentions"`
		MentionsEveryone bool    `json:"mentions_everyone"`
		Referenced       any     `json:"referenced_message"`
		User             struct {
			ID int64 `json:"id"`
		} `json:"user"`
	} `json:"payload"`
}

func decodePinFrame(t *testing.T, raw []byte) pinFrame {
	t.Helper()
	var f pinFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return f
}

func pinResult(author *db.User, channelID, rowID, pinned int64, dm bool, participants []int64) *service.PinEventResult {
	return &service.PinEventResult{
		Row: &db.PinEventRow{
			MessageID: rowID, ChannelID: channelID, UserID: author.ID,
			Content: author.Username + " pinned a message to this channel.", Timestamp: "2026-10-20 10:00:00",
			PinnedMessageID: pinned,
		},
		Author: author, AuthorRole: "Owner", IsDM: dm, ParticipantIDs: participants,
	}
}

func TestPinEventRow_ChannelSequencedNoMention(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	chID := seedTestChannel(t, database, "pins")
	pinner := seedTestUser(t, database, "pinner")
	reader := seedTestUser(t, database, "reader")
	away := seedTestUser(t, database, "away")

	readerSend := make(chan []byte, 8)
	awaySend := make(chan []byte, 8)
	hub.Register(ws.NewTestClientWithChannel(hub, reader, chID, readerSend))
	awayClient := ws.NewTestClientWithChannel(hub, away, 999, awaySend)
	hub.Register(awayClient)
	waitRegistered(t, hub, awayClient)

	pinnerUser := &db.User{ID: pinner, Username: "pinner"}
	hub.PinEventRow(context.Background(), pinResult(pinnerUser, chID, 501, 77, false, nil))

	select {
	case raw := <-readerSend:
		f := decodePinFrame(t, raw)
		if f.Type != "chat_message" || f.Seq == 0 {
			t.Errorf("frame type = %q seq = %d, want a sequenced chat_message", f.Type, f.Seq)
		}
		p := f.Payload
		if p.ID != 501 || p.ChannelID != chID || p.Kind != "pin_add" || p.User.ID != pinner {
			t.Errorf("payload = %+v", p)
		}
		if p.ReplyTo == nil || *p.ReplyTo != 77 {
			t.Errorf("reply_to = %v, want 77", p.ReplyTo)
		}
		if p.Referenced != nil {
			t.Errorf("referenced_message = %v, want null", p.Referenced)
		}
		if p.Mentions == nil || len(p.Mentions) != 0 || p.MentionsEveryone {
			t.Errorf("mentions = %v everyone = %v, want [] and false", p.Mentions, p.MentionsEveryone)
		}
	case <-time.After(time.Second):
		t.Fatal("channel reader did not receive the pin row")
	}
	// A reader focused elsewhere gets the unread hint, never the row itself.
	timer := time.After(500 * time.Millisecond)
collect:
	for {
		select {
		case raw := <-awaySend:
			if pf := decodePinFrame(t, raw); pf.Type == "chat_message" {
				t.Errorf("client focused on another channel received the pin row")
			}
		case <-timer:
			break collect
		}
	}

	var held int
	for _, frame := range hub.ReplayBuffer().AllFramesForTest() {
		if bytes.Contains(frame, []byte(`"pin_add"`)) {
			held++
		}
	}
	if held != 1 {
		t.Errorf("replay ring holds %d pin rows, want 1", held)
	}
}

func TestPinEventRow_DMParticipantsOnly(t *testing.T) {
	t.Parallel()
	f := newCallSinkFixture(t)
	res := pinResult(f.alice, f.dm, 502, 78, true, []int64{f.alice.ID, f.bob.ID})
	f.hub.PinEventRow(context.Background(), res)

	for who, ch := range map[string]chan []byte{"alice": f.aliceSend, "bob": f.bobSend} {
		frames := callFrames(ch, 300*time.Millisecond)
		if len(frames) != 1 {
			t.Fatalf("%s got %d frames, want 1", who, len(frames))
		}
		pf := decodePinFrame(t, mustMarshal(t, frames[0]))
		if pf.Type != "chat_message" || pf.Seq == 0 || pf.Payload.Kind != "pin_add" ||
			pf.Payload.ReplyTo == nil || *pf.Payload.ReplyTo != 78 || !slices.Equal(pf.Payload.Mentions, []int64{}) {
			t.Errorf("%s frame = %+v", who, pf)
		}
	}
	if frames := callFrames(f.outsSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("a user outside the DM received %d frames", len(frames))
	}
}

func TestPinEventRow_NilOrEmptyResultSendsNothing(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.PinEventRow(context.Background(), nil)
	f.hub.PinEventRow(context.Background(), &service.PinEventResult{})
	if frames := callFrames(f.aliceSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("got %d frames, want none", len(frames))
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// gotChatMessage reports whether ch receives a chat_message frame within d.
func gotChatMessage(ch chan []byte, d time.Duration) bool {
	timer := time.After(d)
	for {
		select {
		case raw := <-ch:
			var env struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &env) == nil && env.Type == "chat_message" {
				return true
			}
		case <-timer:
			return false
		}
	}
}

// The pin row takes the ordinary channel path, so a member denied READ on the
// channel and a member who has not acknowledged an NSFW channel receive nothing,
// while an allowed member still does.
func TestPinEventRow_ChannelGates(t *testing.T) {
	t.Parallel()
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	ctx := context.Background()

	chID := seedTestChannel(t, database, "gated")
	if _, err := database.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, chID); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	pinner := seedTestUser(t, database, "gate-pinner")
	acked := seedTestUser(t, database, "gate-acked")
	unacked := seedTestUser(t, database, "gate-unacked")
	denied := seedTestUser(t, database, "gate-denied")
	if _, err := database.AcknowledgeNSFW(ctx, acked, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW: %v", err)
	}
	if _, err := database.AcknowledgeNSFW(ctx, denied, chID); err != nil {
		t.Fatalf("AcknowledgeNSFW(denied): %v", err)
	}
	if err := database.UpsertChannelUserOverride(ctx, chID, denied, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}

	// READ is enforced when a client focuses the channel: a refused focus leaves
	// the connection off the channel topic, so the denied member's client is
	// never subscribed and the pin row has no path to it.
	svc := service.New(database, nil)
	if _, err := svc.Channels.AdmitChannelFocus(ctx, denied, chID); !errors.Is(err, service.ErrForbidden) {
		t.Fatalf("focus without READ: err = %v, want ErrForbidden", err)
	}
	sends := map[string]chan []byte{}
	var last *ws.Client
	for name, uid := range map[string]int64{"acked": acked, "unacked": unacked, "denied": denied} {
		sends[name] = make(chan []byte, 8)
		focus := chID
		if name == "denied" {
			focus = 0
		}
		last = ws.NewTestClientWithChannel(hub, uid, focus, sends[name])
		hub.Register(last)
	}
	waitRegistered(t, hub, last)

	hub.PinEventRow(ctx, pinResult(&db.User{ID: pinner, Username: "gate-pinner"}, chID, 601, 90, false, nil))

	if !gotChatMessage(sends["acked"], time.Second) {
		t.Error("an allowed, acknowledged member did not receive the pin row")
	}
	for _, name := range []string{"unacked", "denied"} {
		if gotChatMessage(sends[name], 300*time.Millisecond) {
			t.Errorf("%s member received the pin row", name)
		}
	}
}
