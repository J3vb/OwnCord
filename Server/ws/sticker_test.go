package ws_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

// ─── sticker_update ──────────────────────────────────────────────────────────

func TestBroadcastStickerUpdate_CarriesNameEmojiAndURL(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "sticker-owner")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	wave := "👋"
	hub.BroadcastStickerUpdate([]*service.Sticker{
		nil,
		{ID: 3, Name: "Wave", Emoji: &wave, StoredAs: "uuid-a", MimeType: "image/png"},
		{ID: 9, Name: "Party Blob", StoredAs: "uuid-b", MimeType: "image/gif"},
	})

	msg := drainForMsgType(t, send, "sticker_update")
	raw, err := json.Marshal(msg["payload"])
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Stickers []struct {
			ID    int64   `json:"id"`
			Name  string  `json:"name"`
			Emoji *string `json:"emoji"`
			URL   string  `json:"url"`
		} `json:"stickers"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Stickers) != 2 {
		t.Fatalf("stickers = %s, want the two non-nil entries", raw)
	}
	if s := payload.Stickers[0]; s.ID != 3 || s.Name != "Wave" || s.Emoji == nil || *s.Emoji != "👋" || s.URL != "/api/v1/stickers/3/image" {
		t.Errorf("first = %+v", s)
	}
	if s := payload.Stickers[1]; s.ID != 9 || s.Emoji != nil || s.URL != "/api/v1/stickers/9/image" {
		t.Errorf("second = %+v", s)
	}
	if strings.Contains(string(raw), "uuid-") || strings.Contains(string(raw), "image/gif") {
		t.Errorf("payload leaks storage details: %s", raw)
	}
}

func TestBroadcastStickerUpdate_EmptySetIsAnArray(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()

	user := seedOwnerUser(t, database, "sticker-empty-owner")
	send := make(chan []byte, 16)
	client := ws.NewTestClientWithUser(hub, user, 0, send)
	hub.Register(client)
	waitRegistered(t, hub, client)

	hub.BroadcastStickerUpdate(nil)
	msg := drainForMsgType(t, send, "sticker_update")
	raw, _ := json.Marshal(msg["payload"])
	if string(raw) != `{"stickers":[]}` {
		t.Errorf("payload = %s, want {\"stickers\":[]}", raw)
	}
}

// ─── chat_send with sticker_id ───────────────────────────────────────────────

type stickerFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Seq     int64  `json:"seq"`
	Payload struct {
		ID        int64  `json:"id"`
		MessageID int64  `json:"message_id"`
		Content   string `json:"content"`
		Code      string `json:"code"`
		Sticker   *struct {
			ID   *int64  `json:"id"`
			Name string  `json:"name"`
			URL  *string `json:"url"`
		} `json:"sticker"`
	} `json:"payload"`
}

func collectStickerFrames(ch <-chan []byte, d time.Duration) []stickerFrame {
	var out []stickerFrame
	for _, raw := range drainChanTimeout(ch, d) {
		var f stickerFrame
		if json.Unmarshal(raw, &f) == nil {
			out = append(out, f)
		}
	}
	return out
}

func firstStickerFrame(frames []stickerFrame, typ string) *stickerFrame {
	for i := range frames {
		if frames[i].Type == typ {
			return &frames[i]
		}
	}
	return nil
}

func (h *forwardHarness) sendSticker(reqID string, channelID int64, mutate func(map[string]any)) {
	payload := map[string]any{"client_message_id": forwardCMID(), "channel_id": channelID}
	if mutate != nil {
		mutate(payload)
	}
	raw, _ := json.Marshal(map[string]any{"type": "chat_send", "id": reqID, "payload": payload})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
}

func TestChatSendSticker_FanoutAndErrors(t *testing.T) {
	h := newForwardHarness(t)
	st, err := h.database.CreateSticker(context.Background(), "Wave", nil, "uuid-wave", "image/png", h.alice.ID)
	if err != nil {
		t.Fatal(err)
	}

	// A sticker send: chat_send_ok to the sender, and one sequenced chat_message
	// with the sticker block and the fallback text to the channel.
	h.sendSticker("req-ok", h.dstChan, func(p map[string]any) { p["sticker_id"] = st.ID })
	ok := firstStickerFrame(collectStickerFrames(h.aliceFrames, 200*time.Millisecond), "chat_send_ok")
	if ok == nil || ok.ID != "req-ok" || ok.Payload.MessageID <= 0 {
		t.Fatalf("chat_send_ok = %+v", ok)
	}
	msg := firstStickerFrame(collectStickerFrames(h.bobFr, 100*time.Millisecond), "chat_message")
	if msg == nil || msg.Seq == 0 || msg.Payload.ID != ok.Payload.MessageID || msg.Payload.Content != "[Sticker: Wave]" {
		t.Fatalf("chat_message = %+v", msg)
	}
	s := msg.Payload.Sticker
	if s == nil || s.ID == nil || *s.ID != st.ID || s.Name != "Wave" || s.URL == nil || *s.URL != "/api/v1/stickers/1/image" {
		t.Fatalf("sticker block = %+v", s)
	}

	// Rejected shapes answer BAD_REQUEST and fan nothing out.
	h.sendSticker("req-text", h.dstChan, func(p map[string]any) { p["sticker_id"] = st.ID; p["content"] = "hi" })
	h.sendSticker("req-zero", h.dstChan, func(p map[string]any) { p["sticker_id"] = 0 })
	h.sendSticker("req-nocmid", h.dstChan, func(p map[string]any) { p["sticker_id"] = st.ID; delete(p, "client_message_id") })
	frames := collectStickerFrames(h.aliceFrames, 200*time.Millisecond)
	for _, id := range []string{"req-text", "req-zero", "req-nocmid"} {
		var got *stickerFrame
		for i := range frames {
			if frames[i].ID == id && frames[i].Type == "error" {
				got = &frames[i]
			}
		}
		if got == nil || got.Payload.Code != "BAD_REQUEST" {
			t.Errorf("%s: error frame = %+v, want BAD_REQUEST", id, got)
		}
	}

	// Edge case (a): the sticker is deleted, then sent.
	if ok, err := h.database.DeleteSticker(context.Background(), st.ID); err != nil || !ok {
		t.Fatalf("DeleteSticker = %v, %v", ok, err)
	}
	h.sendSticker("req-gone", h.dstChan, func(p map[string]any) { p["sticker_id"] = st.ID })
	frames = collectStickerFrames(h.aliceFrames, 200*time.Millisecond)
	var gone *stickerFrame
	for i := range frames {
		if frames[i].ID == "req-gone" {
			gone = &frames[i]
		}
	}
	if gone == nil || gone.Type != "error" || gone.Payload.Code != "STICKER_NOT_FOUND" {
		t.Fatalf("send of a deleted sticker = %+v, want error STICKER_NOT_FOUND", gone)
	}
	if extra := firstStickerFrame(collectStickerFrames(h.bobFr, 100*time.Millisecond), "chat_message"); extra != nil {
		t.Errorf("a refused send reached the channel: %+v", extra)
	}

	// An edit of the sticker message is refused and the text is untouched.
	raw, _ := json.Marshal(map[string]any{"type": "chat_edit", "id": "req-edit",
		"payload": map[string]any{"message_id": ok.Payload.MessageID, "content": "changed"}})
	h.hub.HandleMessageForTest(h.aliceCl, raw)
	var edit *stickerFrame
	for _, f := range collectStickerFrames(h.aliceFrames, 200*time.Millisecond) {
		if f.ID == "req-edit" {
			f := f
			edit = &f
		}
	}
	if edit == nil || edit.Type != "error" || edit.Payload.Code != "BAD_REQUEST" {
		t.Errorf("edit of a sticker message = %+v, want error BAD_REQUEST", edit)
	}
}
