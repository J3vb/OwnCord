package ws_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
)

type removalFrame struct {
	Seq     uint64 `json:"seq"`
	Type    string `json:"type"`
	Payload struct {
		MessageID   int64           `json:"message_id"`
		ChannelID   int64           `json:"channel_id"`
		Content     string          `json:"content"`
		EditedAt    *string         `json:"edited_at"`
		Attachments json.RawMessage `json:"attachments"`
		Mentions    []int64         `json:"mentions"`
	} `json:"payload"`
}

func decodeRemovalFrame(t *testing.T, raw []byte) removalFrame {
	t.Helper()
	var f removalFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("decode frame: %v", err)
	}
	return f
}

func nextFrame(t *testing.T, ch chan []byte) removalFrame {
	t.Helper()
	select {
	case raw := <-ch:
		return decodeRemovalFrame(t, raw)
	case <-time.After(time.Second):
		t.Fatal("no frame arrived")
		return removalFrame{}
	}
}

func TestAttachmentsChanged_ChannelReadersGetChatEditedWithFiles(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	chID := seedTestChannel(t, database, "files")
	reader := seedTestUser(t, database, "reader")
	readerSend := make(chan []byte, 8)
	hub.Register(ws.NewTestClientWithChannel(hub, reader, chID, readerSend))

	width := 640
	hub.AttachmentsChanged(context.Background(), &service.AttachmentsChangedResult{
		MessageID: 9, ChannelID: chID, Content: "text stays", EditedAt: nil,
		Attachments: []db.AttachmentInfo{{ID: "f1", Filename: "a.png", Size: 3, Mime: "image/png", URL: "/api/v1/files/f1", Width: &width}},
		Mentions:    []int64{reader},
	})

	f := nextFrame(t, readerSend)
	if f.Type != "chat_edited" || f.Seq == 0 {
		t.Fatalf("frame type %q seq %d, want a sequenced chat_edited", f.Type, f.Seq)
	}
	if f.Payload.MessageID != 9 || f.Payload.ChannelID != chID || f.Payload.Content != "text stays" {
		t.Errorf("payload = %+v", f.Payload)
	}
	if f.Payload.EditedAt != nil {
		t.Errorf("edited_at = %v, want null for a never-edited message", *f.Payload.EditedAt)
	}
	if !strings.Contains(string(f.Payload.Attachments), `"id":"f1"`) || !strings.Contains(string(f.Payload.Attachments), `"width":640`) {
		t.Errorf("attachments = %s, want the remaining file with its dimensions", f.Payload.Attachments)
	}
	if len(f.Payload.Mentions) != 1 || f.Payload.Mentions[0] != reader {
		t.Errorf("mentions = %v, want [%d]", f.Payload.Mentions, reader)
	}
}

func TestAttachmentsChanged_EmptyListStillReachesTheClient(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	chID := seedTestChannel(t, database, "files")
	reader := seedTestUser(t, database, "reader")
	readerSend := make(chan []byte, 8)
	hub.Register(ws.NewTestClientWithChannel(hub, reader, chID, readerSend))

	edited := "2026-10-01 10:00:00"
	hub.AttachmentsChanged(context.Background(), &service.AttachmentsChangedResult{
		MessageID: 10, ChannelID: chID, Content: "x", EditedAt: &edited,
	})
	select {
	case raw := <-readerSend:
		if !strings.Contains(string(raw), `"attachments":[]`) {
			t.Errorf("frame %s lacks an empty attachments array", raw)
		}
		if !strings.Contains(string(raw), `"mentions":[]`) || !strings.Contains(string(raw), `"edited_at":"2026-10-01 10:00:00"`) {
			t.Errorf("frame %s: want mentions [] and the unchanged edited_at", raw)
		}
	case <-time.After(time.Second):
		t.Fatal("no frame arrived")
	}
}

func TestAttachmentsChanged_DMGoesToParticipantsOnly(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.AttachmentsChanged(context.Background(), &service.AttachmentsChangedResult{
		MessageID: 11, ChannelID: f.dm, Content: "private", IsDM: true,
		ParticipantIDs: []int64{f.alice.ID, f.bob.ID},
	})
	for who, ch := range map[string]chan []byte{"alice": f.aliceSend, "bob": f.bobSend} {
		frames := callFrames(ch, 300*time.Millisecond)
		if len(frames) != 1 || frameType(frames[0]) != "chat_edited" {
			t.Fatalf("%s got %d frames, want one chat_edited", who, len(frames))
		}
	}
	if frames := callFrames(f.outsSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("a user outside the DM received %d frames", len(frames))
	}
}

func TestMessageDeletedByUpload_SendsChatDeleted(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.MessageDeletedByUpload(context.Background(), &service.DeleteMessageResult{
		MessageID: 12, ChannelID: f.dm, IsDM: true, ParticipantIDs: []int64{f.alice.ID, f.bob.ID},
	})
	for who, ch := range map[string]chan []byte{"alice": f.aliceSend, "bob": f.bobSend} {
		frames := callFrames(ch, 300*time.Millisecond)
		if len(frames) != 1 || frameType(frames[0]) != "chat_deleted" {
			t.Fatalf("%s got %d frames, want one chat_deleted", who, len(frames))
		}
	}
	if frames := callFrames(f.outsSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("a user outside the DM received %d frames", len(frames))
	}
}

func TestMessageDeletedByUpload_ChannelReaders(t *testing.T) {
	hub, database := newTestHub(t)
	go hub.Run()
	defer hub.Stop()
	chID := seedTestChannel(t, database, "files")
	reader := seedTestUser(t, database, "reader")
	readerSend := make(chan []byte, 8)
	hub.Register(ws.NewTestClientWithChannel(hub, reader, chID, readerSend))

	hub.MessageDeletedByUpload(context.Background(), &service.DeleteMessageResult{MessageID: 13, ChannelID: chID})
	f := nextFrame(t, readerSend)
	if f.Type != "chat_deleted" || f.Payload.MessageID != 13 || f.Payload.ChannelID != chID {
		t.Errorf("frame = %+v", f)
	}
}

func TestUploadRemovalSink_NilResultsSendNothing(t *testing.T) {
	f := newCallSinkFixture(t)
	f.hub.AttachmentsChanged(context.Background(), nil)
	f.hub.MessageDeletedByUpload(context.Background(), nil)
	if frames := callFrames(f.aliceSend, 100*time.Millisecond); len(frames) != 0 {
		t.Errorf("got %d frames, want none", len(frames))
	}
}
