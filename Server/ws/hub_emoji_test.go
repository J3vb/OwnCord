package ws_test

import (
	"encoding/json"
	"testing"

	"github.com/owncord/server/db"
	"github.com/owncord/server/ws"
)

// ─── emoji_update ────────────────────────────────────────────────────────────

// emojiUpdatePayload mirrors the wire shape the client parses. Declared here
// rather than reused from ws so a change to the broadcast that the client would
// notice also fails this test.
type emojiUpdatePayload struct {
	Emoji []struct {
		ID        int64  `json:"id"`
		Shortcode string `json:"shortcode"`
		URL       string `json:"url"`
	} `json:"emoji"`
}

func decodeEmojiUpdate(t *testing.T, msg map[string]any) emojiUpdatePayload {
	t.Helper()
	raw, err := json.Marshal(msg["payload"])
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var payload emojiUpdatePayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	return payload
}

func TestBroadcastEmojiUpdate_CarriesShortcodeAndURL(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "emoji-owner")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	hub.BroadcastEmojiUpdate([]*db.Emoji{
		{ID: 3, Shortcode: "wave", StoredAs: "uuid-a", MimeType: "image/png"},
		{ID: 9, Shortcode: "party", StoredAs: "uuid-b", MimeType: "image/gif"},
	})

	payload := decodeEmojiUpdate(t, drainForMsgType(t, send, "emoji_update"))
	if len(payload.Emoji) != 2 {
		t.Fatalf("emoji count = %d, want 2", len(payload.Emoji))
	}
	if payload.Emoji[0].Shortcode != "wave" || payload.Emoji[0].URL != "/api/v1/emoji/3/image" {
		t.Errorf("first entry = %+v, want wave at /api/v1/emoji/3/image", payload.Emoji[0])
	}
	if payload.Emoji[1].ID != 9 || payload.Emoji[1].URL != "/api/v1/emoji/9/image" {
		t.Errorf("second entry = %+v, want id 9", payload.Emoji[1])
	}
}

func TestBroadcastEmojiUpdate_EmptySetIsAnArray(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "emoji-empty-owner")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	// Deleting the last emoji broadcasts an empty set; it must be [] and not
	// null, so the client can replace its map unconditionally.
	hub.BroadcastEmojiUpdate(nil)

	msg := drainForMsgType(t, send, "emoji_update")
	raw, err := json.Marshal(msg["payload"])
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := string(raw); got != `{"emoji":[]}` {
		t.Errorf("payload = %s, want {\"emoji\":[]}", got)
	}
}

func TestBroadcastEmojiUpdate_NilEntriesAreSkipped(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "emoji-nil-owner")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	hub.BroadcastEmojiUpdate([]*db.Emoji{nil, {ID: 1, Shortcode: "wave"}})

	payload := decodeEmojiUpdate(t, drainForMsgType(t, send, "emoji_update"))
	if len(payload.Emoji) != 1 || payload.Emoji[0].Shortcode != "wave" {
		t.Fatalf("emoji = %+v, want just the non-nil entry", payload.Emoji)
	}
}
