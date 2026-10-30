package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

type callSinkFixture struct {
	hub              *ws.Hub
	database         *db.DB
	alice, bob, outs *db.User
	dm               int64
	aliceSend        chan []byte
	bobSend          chan []byte
	outsSend         chan []byte
}

func newCallSinkFixture(t *testing.T) *callSinkFixture {
	t.Helper()
	hub, database := newHandlerHub(t)
	f := &callSinkFixture{
		hub: hub, database: database,
		alice: seedOwnerUser(t, database, "sink-alice"),
		bob:   seedOwnerUser(t, database, "sink-bob"),
		outs:  seedOwnerUser(t, database, "sink-outsider"),
	}
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), f.alice.ID, f.bob.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	f.dm = dm.ID
	f.aliceSend, f.bobSend, f.outsSend = make(chan []byte, 64), make(chan []byte, 64), make(chan []byte, 64)
	for _, c := range []*ws.Client{
		ws.NewTestClientWithUser(hub, f.alice, 0, f.aliceSend),
		ws.NewTestClientWithUser(hub, f.bob, 0, f.bobSend),
		ws.NewTestClientWithUser(hub, f.outs, 0, f.outsSend),
	} {
		hub.Register(c)
		waitRegistered(t, hub, c)
	}
	return f
}

// callFrames reads what ch receives for a short while, decoded.
func callFrames(ch chan []byte, d time.Duration) []map[string]json.RawMessage {
	var out []map[string]json.RawMessage
	timer := time.NewTimer(d)
	defer timer.Stop()
	for {
		select {
		case msg := <-ch:
			var env map[string]json.RawMessage
			if json.Unmarshal(msg, &env) == nil {
				out = append(out, env)
			}
		case <-timer.C:
			return out
		}
	}
}

func frameType(env map[string]json.RawMessage) string {
	var s string
	_ = json.Unmarshal(env["type"], &s)
	return s
}

func (f *callSinkFixture) event(call db.CallInfo, content string) service.CallLogEvent {
	return service.CallLogEvent{
		MessageID: 77, ChannelID: f.dm, Author: f.alice, AuthorRole: "Owner",
		Content: content, Timestamp: "2026-10-16 10:00:00", Call: call,
		Audience: []int64{f.alice.ID, f.bob.ID},
	}
}

func TestCallLogSink_ChatMessageSequencedAndReplayedToDMAudience(t *testing.T) {
	f := newCallSinkFixture(t)
	ev := f.event(db.CallInfo{StartedAt: "2026-10-16 10:00:00", Participants: []int64{f.alice.ID}}, "started a call.")
	f.hub.CallLogCreated(context.Background(), ev)

	for name, ch := range map[string]chan []byte{"alice": f.aliceSend, "bob": f.bobSend} {
		frames := callFrames(ch, 300*time.Millisecond)
		if len(frames) != 1 || frameType(frames[0]) != "chat_message" {
			t.Fatalf("%s frames = %v, want one chat_message", name, frames)
		}
		var seq uint64
		if err := json.Unmarshal(frames[0]["seq"], &seq); err != nil || seq == 0 {
			t.Errorf("%s frame seq = %s, want a sequence number", name, frames[0]["seq"])
		}
		var pl struct {
			ID   int64  `json:"id"`
			Kind string `json:"kind"`
			Call struct {
				StartedAt    string  `json:"started_at"`
				EndedAt      *string `json:"ended_at"`
				Participants []int64 `json:"participants"`
			} `json:"call"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(frames[0]["payload"], &pl); err != nil {
			t.Fatal(err)
		}
		if pl.ID != 77 || pl.Kind != "call" || pl.Call.StartedAt != "2026-10-16 10:00:00" || pl.Call.EndedAt != nil || len(pl.Call.Participants) != 1 {
			t.Errorf("%s payload = %+v", name, pl)
		}
	}
	if frames := callFrames(f.outsSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("a user outside the DM received %d frames", len(frames))
	}

	// The frame is in the replay ring, so a reconnecting client gets it.
	var held int
	for _, frame := range f.hub.ReplayBuffer().AllFramesForTest() {
		if bytes.Contains(frame, []byte(`"kind":"call"`)) {
			held++
		}
	}
	if held != 1 {
		t.Errorf("replay ring holds %d call frames, want 1", held)
	}
}

func TestCallLogSink_EndIsChatEditedWithNullEditedAt(t *testing.T) {
	f := newCallSinkFixture(t)
	ended := "2026-10-16 10:05:00"
	ev := f.event(db.CallInfo{StartedAt: "2026-10-16 10:00:00", EndedAt: &ended, Participants: []int64{f.alice.ID, f.bob.ID}},
		"started a call that lasted 5 minutes.")
	f.hub.CallLogEnded(context.Background(), ev)

	frames := callFrames(f.bobSend, 300*time.Millisecond)
	if len(frames) != 1 || frameType(frames[0]) != "chat_edited" {
		t.Fatalf("bob frames = %v, want one chat_edited", frames)
	}
	var pl map[string]json.RawMessage
	if err := json.Unmarshal(frames[0]["payload"], &pl); err != nil {
		t.Fatal(err)
	}
	if string(pl["edited_at"]) != "null" {
		t.Errorf("edited_at = %s, want null (the row must not read as edited)", pl["edited_at"])
	}
	if string(pl["kind"]) != `"call"` || string(pl["mentions"]) != "[]" {
		t.Errorf("kind/mentions = %s / %s", pl["kind"], pl["mentions"])
	}
	var call struct {
		EndedAt      *string `json:"ended_at"`
		Participants []int64 `json:"participants"`
	}
	if err := json.Unmarshal(pl["call"], &call); err != nil || call.EndedAt == nil || *call.EndedAt != ended || len(call.Participants) != 2 {
		t.Errorf("call = %s (%v)", pl["call"], err)
	}
	if string(pl["content"]) != `"started a call that lasted 5 minutes."` {
		t.Errorf("content = %s", pl["content"])
	}
	if len(callFrames(f.outsSend, 100*time.Millisecond)) != 0 {
		t.Error("a user outside the DM received the end frame")
	}
}

func TestCallLogSink_ReopenComesBeforeChatMessage(t *testing.T) {
	f := newCallSinkFixture(t)
	ev := f.event(db.CallInfo{StartedAt: "2026-10-16 10:00:00", Participants: []int64{f.alice.ID}}, "started a call.")
	ev.Reopens = []service.RingReopen{{UserID: f.bob.ID, Summary: db.DMChannelInfo{ChannelID: f.dm}}}
	f.hub.CallLogCreated(context.Background(), ev)

	frames := callFrames(f.bobSend, 300*time.Millisecond)
	if len(frames) != 2 || frameType(frames[0]) != "dm_channel_open" || frameType(frames[1]) != "chat_message" {
		t.Fatalf("bob frames = %v, want dm_channel_open then chat_message", frames)
	}
	if got := callFrames(f.aliceSend, 100*time.Millisecond); len(got) != 1 {
		t.Errorf("alice frames = %d, want only the chat_message", len(got))
	}
}

// Plugins never see call rows: the sink goes through the sequenced DM path,
// which skips the plugin hook.
func TestCallLogSink_PluginsNeverSeeCallRows(t *testing.T) {
	f := newCallSinkFixture(t)
	sink := plugin.NewEventSink()
	f.hub.SetPluginEventSink(sink)
	ended := "2026-10-16 10:05:00"
	f.hub.CallLogCreated(context.Background(), f.event(db.CallInfo{StartedAt: "2026-10-16 10:00:00"}, "started a call."))
	f.hub.CallLogEnded(context.Background(), f.event(db.CallInfo{StartedAt: "2026-10-16 10:00:00", EndedAt: &ended}, "started a call that lasted 5 minutes."))
	if len(callFrames(f.bobSend, 300*time.Millisecond)) != 2 {
		t.Fatal("the frames were not delivered")
	}
	if n := sink.DispatchCount.Load(); n != 0 {
		t.Errorf("plugin sink received %d dispatches for call rows, want 0", n)
	}
}

// The hub installs itself as the call log's sink, so a join noted on the
// service layer reaches the DM's participants as a chat_message.
func TestCallLog_JoinReachesDMThroughHub(t *testing.T) {
	t.Parallel()
	// The fully migrated schema: the call tables are not in the hand-written
	// handler schema.
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(hub.Stop)

	alice, bob := seedOwnerUser(t, database, "e2e-alice"), seedOwnerUser(t, database, "e2e-bob")
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range [][2]int64{{alice.ID, bob.ID}, {bob.ID, alice.ID}} {
		if err := database.TrustSender(context.Background(), p[0], p[1], "accepted"); err != nil {
			t.Fatal(err)
		}
	}
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, bob, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	ctx := t.Context()
	stop := svc.CallLog.StartCallLogWorker(ctx)
	defer stop(ctx)

	if err := svc.Voice.Join(ctx, alice.ID, dm.ID, 0); err != nil {
		t.Fatal(err)
	}
	svc.Voice.NoteJoinCompleted(dm.ID, alice.ID)

	deadline := time.After(10 * time.Second)
	for {
		select {
		case msg := <-send:
			if bytes.Contains(msg, []byte(`"type":"chat_message"`)) && bytes.Contains(msg, []byte(`"kind":"call"`)) {
				return
			}
		case <-deadline:
			t.Fatal("the call log row never reached the other participant")
		}
	}
}

// The callee declining is a stateless nudge: it adds no participant to the
// call row the caller's join produced.
func TestCallLog_DeclineAddsNoParticipant(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(hub.Stop)

	alice, bob := seedOwnerUser(t, database, "decl-alice"), seedOwnerUser(t, database, "decl-bob")
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range [][2]int64{{alice.ID, bob.ID}, {bob.ID, alice.ID}} {
		if err := database.TrustSender(context.Background(), p[0], p[1], "accepted"); err != nil {
			t.Fatal(err)
		}
	}
	send := make(chan []byte, 64)
	c := ws.NewTestClientWithUser(hub, bob, 0, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	ctx := t.Context()
	stop := svc.CallLog.StartCallLogWorker(ctx)
	defer stop(ctx)
	if err := svc.Voice.Join(ctx, alice.ID, dm.ID, 0); err != nil {
		t.Fatal(err)
	}
	svc.Voice.NoteJoinCompleted(dm.ID, alice.ID)

	raw, _ := json.Marshal(map[string]any{"type": "call_decline", "payload": map[string]any{"channel_id": dm.ID}})
	hub.HandleMessageForTest(c, raw)

	deadline := time.After(10 * time.Second)
	for {
		select {
		case msg := <-send:
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					Kind string `json:"kind"`
					Call struct {
						Participants []int64 `json:"participants"`
					} `json:"call"`
				} `json:"payload"`
			}
			if json.Unmarshal(msg, &env) != nil || env.Type != "chat_message" || env.Payload.Kind != "call" {
				continue
			}
			if len(env.Payload.Call.Participants) != 1 || env.Payload.Call.Participants[0] != alice.ID {
				t.Errorf("participants = %v, want only the caller", env.Payload.Call.Participants)
			}
			var n int
			if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_call_participants WHERE user_id = ?`, bob.ID).Scan(&n); err != nil || n != 0 {
				t.Errorf("the callee was recorded as a participant (%d, %v)", n, err)
			}
			return
		case <-deadline:
			t.Fatal("the call row never reached the callee")
		}
	}
}
