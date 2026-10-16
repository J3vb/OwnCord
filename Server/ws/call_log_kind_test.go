package ws_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Only the server writes a call log row. A chat_send that names kind and call
// is an ordinary message: it is stored with kind 0 and its frame carries
// neither field.
func TestChatSend_ClientKindAndCallFieldsIgnored(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "send-kind1")
	chID := seedTestChannel(t, database, "send-kind-chan")
	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, user, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID, "content": "pretend call", "kind": "call",
			"call": map[string]any{"started_at": "2026-10-16 10:00:00", "ended_at": nil, "participants": []int64{user.ID}},
		},
	})
	hub.HandleMessageForTest(c, raw)

	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case msg := <-send:
			var env struct {
				Type    string                     `json:"type"`
				Payload map[string]json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(msg, &env) != nil || env.Type != "chat_message" {
				continue
			}
			for _, key := range []string{"kind", "call"} {
				if _, present := env.Payload[key]; present {
					t.Errorf("chat_message payload carries %q: %s", key, msg)
				}
			}
			var id int64
			if err := json.Unmarshal(env.Payload["id"], &id); err != nil {
				t.Fatalf("frame id: %v", err)
			}
			m, err := database.GetMessage(context.Background(), id)
			if err != nil || m == nil || m.Kind != db.MessageKindUser {
				t.Fatalf("stored message = %+v (%v), want kind 0", m, err)
			}
			var calls int
			if err := database.QueryRowContext(context.Background(),
				`SELECT COUNT(*) FROM message_calls`).Scan(&calls); err != nil || calls != 0 {
				t.Errorf("message_calls rows = %d (%v), want 0", calls, err)
			}
			return
		case <-timer.C:
			t.Fatal("no chat_message broadcast")
		}
	}
}

// The db layer cannot import ws, so it carries the wire name itself. The two
// must stay the generated enum value.
func TestMessageKindCall_WireNameMatchesSchemaEnum(t *testing.T) {
	if db.MessageKindNameCall != string(ws.MessageKindCall) {
		t.Errorf("db wire name %q, generated enum %q", db.MessageKindNameCall, ws.MessageKindCall)
	}
}
