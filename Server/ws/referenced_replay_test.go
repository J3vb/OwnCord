package ws_test

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// The ring-buffer twins of the persisted predicates must also name a reply
// frame by the parent embedded in it.
func TestEventNames_ReferencedParent(t *testing.T) {
	frame := []byte(`{"seq":1,"type":"chat_message","payload":{"id":300,"user":{"id":2},` +
		`"referenced_message":{"id":100,"user":{"id":42},"content":"old"}}}`)
	if !ws.EventNamesMessageForTest(frame, map[int64]struct{}{100: {}}) {
		t.Error("eventNamesMessage must match the referenced parent id")
	}
	if ws.EventNamesMessageForTest(frame, map[int64]struct{}{101: {}}) {
		t.Error("eventNamesMessage matched an unrelated id")
	}
	if !ws.EventNamesUserForTest(frame, 42) {
		t.Error("eventNamesUser must match the referenced parent's author")
	}
	if ws.EventNamesUserForTest(frame, 43) {
		t.Error("eventNamesUser matched an unrelated user")
	}
}

// The live frame carries the parent snippet, but the copy kept for replay
// must not: replay after the parent is deleted would otherwise serve its text.
func TestChatSend_ReplayCopyOmitsReferencedSnippet(t *testing.T) {
	hub, database := newHandlerHub(t)
	user := seedOwnerUser(t, database, "replay-refmsg1")
	chID := seedTestChannel(t, database, "replay-refmsg-chan")
	parentID, err := database.CreateMessage(context.Background(), chID, user.ID, "secret parent text", nil)
	if err != nil {
		t.Fatal(err)
	}
	c := ws.NewTestClientWithUser(hub, user, chID, make(chan []byte, 32))
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type":    "chat_send",
		"payload": map[string]any{"channel_id": chID, "content": "the reply", "reply_to": parentID},
	})
	hub.HandleMessageForTest(c, raw)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, f := range hub.ReplayBuffer().AllFramesForTest() {
			if !bytes.Contains(f, []byte(`"the reply"`)) {
				continue
			}
			if bytes.Contains(f, []byte("secret parent text")) {
				t.Fatalf("replay frame carries the parent snippet: %s", f)
			}
			var env struct {
				Payload struct {
					ReplyTo           *int64          `json:"reply_to"`
					ReferencedMessage json.RawMessage `json:"referenced_message"`
				} `json:"payload"`
			}
			if err := json.Unmarshal(f, &env); err != nil || env.Payload.ReplyTo == nil || string(env.Payload.ReferencedMessage) != "null" {
				t.Fatalf("replay frame = %s (%v)", f, err)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("reply frame never reached the replay buffer")
}
