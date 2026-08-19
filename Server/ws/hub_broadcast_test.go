package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// BroadcastUserUpdate, BroadcastDropCount and SetEventPersister had no
// coverage. The first is what propagates a profile or identity-key change to
// every connected client — an identity key that fails to propagate silently
// breaks E2EE key agreement for everyone already online.

// awaitRawMessage reads one raw frame from ch, failing if none arrives.
func awaitRawMessage(t *testing.T, ch chan []byte) []byte {
	t.Helper()
	select {
	case raw := <-ch:
		return raw
	case <-time.After(2 * time.Second):
		t.Fatal("no message received")
		return nil
	}
}

// awaitMessage reads one message from ch, failing if none arrives.
func awaitMessage(t *testing.T, ch chan []byte) map[string]any {
	t.Helper()
	raw := awaitRawMessage(t, ch)
	var msg map[string]any
	if err := json.Unmarshal(raw, &msg); err != nil {
		t.Fatalf("unmarshal %q: %v", raw, err)
	}
	return msg
}

func TestHub_BroadcastUserUpdate(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	client := ws.NewTestClient(hub, 1, send)
	hub.RegisterNowForTest(client)

	avatar := "avatar.png"
	identityKey := "pubkey-abc"
	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 42, Username: "renamed", Avatar: &avatar, IdentityPublicKey: &identityKey})

	msg := awaitMessage(t, send)
	if msg["type"] != "user_update" {
		t.Fatalf("type = %v, want user_update", msg["type"])
	}
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload is not an object: %v", msg["payload"])
	}
	if payload["user_id"] != float64(42) {
		t.Errorf("user_id = %v, want 42", payload["user_id"])
	}
	if payload["username"] != "renamed" {
		t.Errorf("username = %v, want renamed", payload["username"])
	}
	if payload["avatar"] != "avatar.png" {
		t.Errorf("avatar = %v, want avatar.png", payload["avatar"])
	}
	// The identity key is the E2EE handshake input; dropping it here would
	// leave peers unable to derive a session with this user.
	if payload["identity_public_key"] != "pubkey-abc" {
		t.Errorf("identity_public_key = %v, want pubkey-abc", payload["identity_public_key"])
	}
}

func TestHub_BroadcastUserUpdate_NilOptionalFields(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, send))

	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 42, Username: "noextras"})

	msg := awaitMessage(t, send)
	payload, ok := msg["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload is not an object: %v", msg["payload"])
	}
	if payload["username"] != "noextras" {
		t.Errorf("username = %v, want noextras", payload["username"])
	}
	// A user with no avatar / no published key must serialize as null rather
	// than an empty string, so clients can tell "unset" from "cleared".
	if v, present := payload["avatar"]; present && v != nil {
		t.Errorf("avatar = %v, want null", v)
	}
	if v, present := payload["identity_public_key"]; present && v != nil {
		t.Errorf("identity_public_key = %v, want null", v)
	}
}

func TestHub_BroadcastUserUpdate_ReachesEveryClient(t *testing.T) {
	hub, _ := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	a := make(chan []byte, 8)
	b := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, a))
	hub.RegisterNowForTest(ws.NewTestClient(hub, 2, b))

	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 7, Username: "everyone"})

	for i, ch := range []chan []byte{a, b} {
		msg := awaitMessage(t, ch)
		if msg["type"] != "user_update" {
			t.Errorf("client %d got type %v, want user_update", i, msg["type"])
		}
	}
}

func TestHub_BroadcastDropCount(t *testing.T) {
	hub, _ := newTestHub(t)

	// A hub that has broadcast nothing has dropped nothing. The admin
	// diagnostics endpoint reads this counter, so a nonzero baseline would
	// read as backpressure that never happened.
	if got := hub.BroadcastDropCount(); got != 0 {
		t.Errorf("BroadcastDropCount = %d on a fresh hub, want 0", got)
	}

	go hub.Run()
	t.Cleanup(hub.Stop)

	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, 1, send))
	hub.BroadcastUserUpdate(ws.UserUpdate{UserID: 1, Username: "u"})
	awaitMessage(t, send)

	// A single delivered broadcast must not increment the drop counter.
	if got := hub.BroadcastDropCount(); got != 0 {
		t.Errorf("BroadcastDropCount = %d after one delivered broadcast, want 0", got)
	}
}

// TestHub_ChannelReadAudience_ExcludesArchivedChannel is OC-0073:
// channelReadAudience (shared by BroadcastChannelCreate/Update and the voice
// event / CleanupVoiceForChannel fan-outs) never checked ch.Archived, unlike
// its sibling RefreshChannelVisibility which treats an archived channel as
// invisible to every role. A Member has base READ_MESSAGES with no override,
// so before archiving they are a legitimate audience member for this channel;
// archiving it must remove them from channelReadAudience even though their
// role's READ_MESSAGES grant never changed.
func TestHub_ChannelReadAudience_ExcludesArchivedChannel(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	t.Cleanup(hub.Stop)

	member := seedMemberUser(t, database, "archived-audience-member")
	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, member.ID, send))

	chID := seedTestChannel(t, database, "will-be-archived")

	ch, err := database.GetChannel(context.Background(), chID)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	if err := database.AdminUpdateChannel(context.Background(), chID, db.ChannelUpdate{
		Name:     ch.Name,
		Topic:    ch.Topic,
		Category: ch.Category,
		SlowMode: ch.SlowMode,
		Position: ch.Position,
		Archived: true,
	}); err != nil {
		t.Fatalf("AdminUpdateChannel: %v", err)
	}
	archived, err := database.GetChannel(context.Background(), chID)
	if err != nil || archived == nil {
		t.Fatalf("GetChannel after archive: %v", err)
	}
	if !archived.Archived {
		t.Fatalf("channel not archived after AdminUpdateChannel")
	}

	hub.BroadcastChannelUpdate(archived)

	assertNotReceived(t, send, "member with base READ_MESSAGES on an archived channel")
}

// stubDMEvent is a minimal ws.SequencedDMEvent so EmitEvents routes through
// sendSequencedToUsers — persistEvent's second call site, the one that stamps
// a non-zero channel_id without going through the broadcast queue.
type stubDMEvent struct {
	channelID      int64
	participantIDs []int64
	payload        []byte
}

func (e stubDMEvent) EventType() string       { return "chat_message" }
func (e stubDMEvent) ChannelID() int64        { return e.channelID }
func (e stubDMEvent) ParticipantIDs() []int64 { return e.participantIDs }
func (e stubDMEvent) Payload() []byte         { return e.payload }

// TestHub_SetEventPersister pins the invariant persistEvent exists for: the
// row written to the EventStore carries the same seq (and type, and channel)
// as the wrapped payload the client received — from both call sites,
// deliverBroadcast and sendSequencedToUsers. Cold-tier reconnect replay
// selects rows by row-seq against the payload-seq the client acked, so a
// mismatch silently replays the wrong window.
func TestHub_SetEventPersister(t *testing.T) {
	hub, database := newTestHub(t)

	// The persister needs the real events table; the hub's own test schema has
	// none, so the store is a separately migrated DB.
	store := openEventStoreDB(t)
	persister := ws.NewEventPersister(store, 64, 1, 5*time.Millisecond)
	persister.Start(context.Background())

	// Setting and clearing must both be safe — SetEventPersister is called at
	// startup and again on shutdown/reconfiguration.
	hub.SetEventPersister(persister)
	hub.SetEventPersister(nil)
	hub.SetEventPersister(persister)

	go hub.Run()
	t.Cleanup(func() {
		hub.Stop()
		persister.Stop(context.Background())
	})

	user := seedMemberUser(t, database, "persisted-event-member")
	chID := seedTestChannel(t, database, "persisted-event-dm")

	send := make(chan []byte, 8)
	hub.RegisterNowForTest(ws.NewTestClient(hub, user.ID, send))

	// Global broadcast → deliverBroadcast → persistEvent(seq, 0, wrapped).
	hub.BroadcastToAll([]byte(`{"type":"user_update","payload":{"user_id":7}}`))
	globalFrame := awaitRawMessage(t, send)

	// Sequenced DM → sendSequencedToUsers → persistEvent(seq, chID, wrapped).
	hub.EmitEvents(context.Background(), []ws.Event{stubDMEvent{
		channelID:      chID,
		participantIDs: []int64{user.ID},
		payload:        []byte(`{"type":"chat_message","payload":{"id":1}}`),
	}})
	dmFrame := awaitRawMessage(t, send)

	// Stop drains the queue and waits for the flusher to exit, so everything
	// enqueued above is on disk once it returns. The cleanup's second Stop is
	// a no-op.
	persister.Stop(context.Background())

	stored, err := store.GetEventsSince(context.Background(), 0, 100)
	if err != nil {
		t.Fatalf("GetEventsSince: %v", err)
	}
	bySeq := make(map[int64]db.PersistedEvent, len(stored))
	seen := make([]int64, 0, len(stored))
	for _, row := range stored {
		bySeq[row.Seq] = row
		seen = append(seen, row.Seq)
	}

	cases := []struct {
		label     string
		frame     []byte
		eventType string
		channelID int64
	}{
		{"global broadcast", globalFrame, "user_update", 0},
		{"sequenced DM", dmFrame, "chat_message", chID},
	}
	seqs := make([]int64, 0, len(cases))
	for _, tc := range cases {
		var wire struct {
			Seq  int64  `json:"seq"`
			Type string `json:"type"`
		}
		if err := json.Unmarshal(tc.frame, &wire); err != nil {
			t.Fatalf("%s: unmarshal %q: %v", tc.label, tc.frame, err)
		}
		if wire.Seq == 0 {
			t.Fatalf("%s: delivered frame carries no seq: %s", tc.label, tc.frame)
		}
		if wire.Type != tc.eventType {
			t.Fatalf("%s: frame type = %q, want %q", tc.label, wire.Type, tc.eventType)
		}
		seqs = append(seqs, wire.Seq)

		row, ok := bySeq[wire.Seq]
		if !ok {
			t.Fatalf("%s: no persisted row at the delivered seq %d (stored seqs %v)",
				tc.label, wire.Seq, seen)
		}
		if row.EventType != tc.eventType {
			t.Errorf("%s: row event_type = %q, want %q", tc.label, row.EventType, tc.eventType)
		}
		if row.ChannelID != tc.channelID {
			t.Errorf("%s: row channel_id = %d, want %d", tc.label, row.ChannelID, tc.channelID)
		}
		if string(row.Payload) != string(tc.frame) {
			t.Errorf("%s: row payload = %s, want the delivered frame %s", tc.label, row.Payload, tc.frame)
		}
	}
	if seqs[1] <= seqs[0] {
		t.Errorf("seqs not monotonic across the two persist call sites: %v", seqs)
	}
}
