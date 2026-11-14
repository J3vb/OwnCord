package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/linkwire"
	"github.com/J3vb/OwnCord/Server/ws"
)

func titledCard(title string) linkwire.Card {
	return linkwire.Card{URL: "https://example.com/a", Title: &title, Image: &linkwire.Image{Hash: "h", Width: 640, Height: 320}}
}

func TestLinkPreviewsChanged_ChannelSubscribersGetASequencedReplayableFrame(t *testing.T) {
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)

	h.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{
		MessageID: 77, ChannelID: h.dstChan, Cards: []linkwire.Card{titledCard("Hello")},
	})
	f := rawFrame(t, h.aliceFrames, "message_link_previews", time.Second)
	p := payloadOf(f)
	cards, _ := p["link_previews"].([]any)
	if p["message_id"] != float64(77) || p["channel_id"] != float64(h.dstChan) || len(cards) != 1 {
		t.Fatalf("payload = %+v", p)
	}
	card, _ := cards[0].(map[string]any)
	img, _ := card["image"].(map[string]any)
	if card["title"] != "Hello" || card["url"] != "https://example.com/a" || img["hash"] != "h" || img["width"] != float64(640) {
		t.Errorf("card = %+v", card)
	}
	if _, has := card["description"]; has {
		t.Error("an absent field must be omitted, not null")
	}
	if seq, _ := f["seq"].(float64); seq == 0 {
		t.Error("the frame is not sequenced")
	}
	if !replayHas(h.hub, `"type":"message_link_previews"`, `"message_id":77`) {
		t.Error("the frame is not in the replay buffer")
	}
}

// An empty list is sent as [], never null: it tells clients to drop the cards they hold.
func TestLinkPreviewsChanged_ClearIsAnEmptyArray(t *testing.T) {
	h := newForwardHarness(t)
	h.focus(h.aliceCl, h.dstChan)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	h.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{MessageID: 5, ChannelID: h.dstChan})
	p := payloadOf(rawFrame(t, h.aliceFrames, "message_link_previews", time.Second))
	cards, ok := p["link_previews"].([]any)
	if !ok || len(cards) != 0 {
		t.Errorf("link_previews = %#v, want []", p["link_previews"])
	}
}

func TestLinkPreviewsChanged_DMGoesToParticipantsOnly(t *testing.T) {
	h := newForwardHarness(t)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	// No participant list: nothing goes out, not even to the channel topic.
	h.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{MessageID: 9, ChannelID: h.dmChan, IsDM: true, Cards: []linkwire.Card{titledCard("x")}})
	if f := nextFrameOfType(h.aliceFrames, "message_link_previews", 150*time.Millisecond); f != nil {
		t.Fatalf("a DM update without participants was sent: %+v", f)
	}

	h.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{
		MessageID: 9, ChannelID: h.dmChan, IsDM: true, ParticipantIDs: []int64{h.alice.ID, h.bob.ID}, Cards: []linkwire.Card{titledCard("x")},
	})
	for name, ch := range map[string]<-chan []byte{"alice": h.aliceFrames, "bob": h.bobFr} {
		if f := nextFrameOfType(ch, "message_link_previews", time.Second); f == nil {
			t.Errorf("%s did not get the DM update", name)
		}
	}
	if !replayHas(h.hub, `"type":"message_link_previews"`, fmt.Sprintf(`"channel_id":%d`, h.dmChan)) {
		t.Error("the DM frame is not in the replay buffer")
	}
}

// The frame discloses what a message links to, so an unacknowledged NSFW subscriber is not sent it.
func TestLinkPreviewsChanged_NSFWGated(t *testing.T) {
	h := newForwardHarness(t)
	if _, err := h.database.ExecContext(context.Background(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, h.dstChan); err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.AcknowledgeNSFW(context.Background(), h.alice.ID, h.dstChan); err != nil {
		t.Fatal(err)
	}
	h.focus(h.aliceCl, h.dstChan)
	h.focus(h.bobCl, h.dstChan)
	drainChanTimeout(h.aliceFrames, 50*time.Millisecond)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	h.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{MessageID: 3, ChannelID: h.dstChan, Cards: []linkwire.Card{titledCard("x")}})
	if nextFrameOfType(h.aliceFrames, "message_link_previews", time.Second) == nil {
		t.Error("the acknowledged member did not get the update")
	}
	if f := nextFrameOfType(h.bobFr, "message_link_previews", 200*time.Millisecond); f != nil {
		t.Errorf("an unacknowledged member received %+v", f)
	}
}

// readyUnfurler stands for a worker whose card is already cached: it announces the moment it is
// handed a job.
type readyUnfurler struct {
	hub *ws.Hub
}

func (u readyUnfurler) Enqueue(j linkpreview.Job) {
	u.hub.LinkPreviewsChanged(context.Background(), ws.LinkPreviewUpdate{
		MessageID: j.MessageID, ChannelID: j.ChannelID, Version: j.Version, Cards: []linkwire.Card{titledCard("cached")},
	})
}
func (readyUnfurler) EnqueueBackfill([]linkpreview.Job) int { return 0 }
func (readyUnfurler) NoteShown([]string, []string)          {}

func seqOf(t *testing.T, f map[string]any) float64 {
	t.Helper()
	seq, _ := f["seq"].(float64)
	if seq == 0 {
		t.Fatalf("frame %v has no seq", f["type"])
	}
	return seq
}

// A card that is already cached is announced the instant its job is queued; the job is queued
// only after the message's own frame is out, so the card never overtakes its message.
func TestLinkPreviews_CachedCardIsSequencedAfterItsMessage(t *testing.T) {
	h := newForwardHarness(t)
	h.svc.Messages.SetLinkUnfurler(readyUnfurler{hub: h.hub})
	h.focus(h.bobCl, h.dstChan)
	drainChanTimeout(h.bobFr, 50*time.Millisecond)

	send, _ := json.Marshal(map[string]any{
		"type": "chat_send", "id": "r1",
		"payload": map[string]any{"channel_id": h.dstChan, "content": "see https://example.com/a"},
	})
	h.hub.HandleMessageForTest(h.aliceCl, send)
	if f := nextFrameOfType(h.aliceFrames, "error", 100*time.Millisecond); f != nil {
		t.Fatalf("chat_send refused: %v", f)
	}
	msg := rawFrame(t, h.bobFr, "chat_message", 2*time.Second)
	card := rawFrame(t, h.bobFr, "message_link_previews", 2*time.Second)
	if seqOf(t, msg) >= seqOf(t, card) {
		t.Fatalf("chat_message seq %v is not before message_link_previews seq %v", msg["seq"], card["seq"])
	}
	id := payloadOf(msg)["id"]
	if payloadOf(card)["message_id"] != id || payloadOf(card)["content_version"] == "" {
		t.Errorf("card payload = %+v for message %v", payloadOf(card), id)
	}

	edit, _ := json.Marshal(map[string]any{
		"type": "chat_edit", "id": "r2",
		"payload": map[string]any{"message_id": id, "content": "now https://example.com/b"},
	})
	h.hub.HandleMessageForTest(h.aliceCl, edit)
	edited := rawFrame(t, h.bobFr, "chat_edited", 2*time.Second)
	card = rawFrame(t, h.bobFr, "message_link_previews", 2*time.Second)
	if seqOf(t, edited) >= seqOf(t, card) {
		t.Fatalf("chat_edited seq %v is not before message_link_previews seq %v", edited["seq"], card["seq"])
	}
}
