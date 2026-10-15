package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/google/uuid"
)

// The first ack is intentionally ignored, as though its socket were lost.
// Reissuing under another transport id must produce the old ack but no new
// channel event, replay entry, or mention increment.
func TestChatDelivery_LostAckRetryDoesNotBroadcastAgain(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	hub.RunMentionCountsInlineForTest()
	author := seedCoverageOwner(t, database, "delivery-author")
	target := seedCoverageOwner(t, database, "delivery-target")
	channelID := seedTestChannel(t, database, "delivery-general")
	frames := make(chan []byte, 32)
	client := ws.NewTestClientWithUser(hub, author, channelID, frames)
	hub.Register(client)
	waitRegistered(t, hub, client)
	key := fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString())
	send := func(requestID string) {
		t.Helper()
		raw, err := json.Marshal(map[string]any{"type": "chat_send", "id": requestID,
			"payload": map[string]any{"channel_id": channelID, "content": "hello @delivery-target", "client_message_id": key}})
		if err != nil {
			t.Fatal(err)
		}
		hub.HandleMessageForTest(client, raw)
	}
	type frame struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			MessageID       int64  `json:"message_id"`
			Timestamp       string `json:"timestamp"`
			ClientMessageID string `json:"client_message_id"`
			Deduplicated    bool   `json:"deduplicated"`
		} `json:"payload"`
	}
	send("lost-ack")
	var original frame
	broadcasts := 0
	for _, raw := range drainChanTimeout(frames, 150*time.Millisecond) {
		var f frame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if f.Type == "chat_message" {
			broadcasts++
			if f.Payload.ClientMessageID != key {
				t.Fatalf("broadcast omitted logical id: %s", raw)
			}
		}
		if f.Type == "chat_send_ok" {
			original = f
		}
	}
	if broadcasts != 1 || original.Payload.MessageID <= 0 {
		t.Fatalf("first send broadcasts=%d ack=%+v", broadcasts, original)
	}
	send("retry-ack")
	acks := 0
	for _, raw := range drainChanTimeout(frames, 150*time.Millisecond) {
		var f frame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		if f.Type == "chat_message" {
			t.Fatalf("retry rebroadcast: %s", raw)
		}
		if f.Type != "chat_send_ok" {
			continue
		}
		acks++
		if f.ID != "retry-ack" || !f.Payload.Deduplicated || f.Payload.MessageID != original.Payload.MessageID || f.Payload.Timestamp != original.Payload.Timestamp || f.Payload.ClientMessageID != key {
			t.Fatalf("retry ack = %s", raw)
		}
	}
	if acks != 1 {
		t.Fatalf("retry acks=%d", acks)
	}
	if count, err := database.GetMentionCount(context.Background(), target.ID, channelID); err != nil || count != 1 {
		t.Fatalf("mention count=%d, %v", count, err)
	}
}

type skippedTestFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Payload struct {
		MessageID  int64    `json:"message_id"`
		Skipped    []string `json:"skipped_attachment_ids"`
		Code       string   `json:"code"`
		Deduplicat bool     `json:"deduplicated"`
	} `json:"payload"`
}

// newSkippedAttachmentFixture seeds an owner (who may attach files) with one
// real upload, "real-att", and returns a sender for chat_send frames.
func newSkippedAttachmentFixture(t *testing.T) (send func(reqID string, payload map[string]any) []skippedTestFrame, channelID int64) {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(database, limiter)
	hub := newTestHubDeps(t, database, limiter, svc)
	go hub.Run()
	t.Cleanup(func() { hub.Stop() })
	author := seedCoverageOwner(t, database, "skip-author")
	channelID = seedTestChannel(t, database, "skip-general")
	if err := database.CreateAttachment(context.Background(), "real-att", author.ID, "a.png", "s-a.png", "image/png", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	frames := make(chan []byte, 32)
	client := ws.NewTestClientWithUser(hub, author, channelID, frames)
	hub.Register(client)
	waitRegistered(t, hub, client)
	send = func(reqID string, payload map[string]any) []skippedTestFrame {
		t.Helper()
		payload["channel_id"] = channelID
		raw, err := json.Marshal(map[string]any{"type": "chat_send", "id": reqID, "payload": payload})
		if err != nil {
			t.Fatal(err)
		}
		hub.HandleMessageForTest(client, raw)
		raws := drainChanTimeout(frames, 150*time.Millisecond)
		out := make([]skippedTestFrame, 0, len(raws))
		for _, b := range raws {
			var f skippedTestFrame
			if err := json.Unmarshal(b, &f); err != nil {
				t.Fatal(err)
			}
			out = append(out, f)
		}
		return out
	}
	return send, channelID
}

func findSkippedFrame(frames []skippedTestFrame, typ string) *skippedTestFrame {
	for i := range frames {
		if frames[i].Type == typ {
			return &frames[i]
		}
	}
	return nil
}

func TestChatSend_AckCarriesSkippedAttachmentIDs(t *testing.T) {
	send, _ := newSkippedAttachmentFixture(t)
	key := fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString())
	body := func() map[string]any {
		return map[string]any{"content": "hi", "client_message_id": key, "attachments": []string{"real-att", "ghost-att"}}
	}
	ack := findSkippedFrame(send("first", body()), "chat_send_ok")
	if ack == nil || len(ack.Payload.Skipped) != 1 || ack.Payload.Skipped[0] != "ghost-att" {
		t.Fatalf("ack = %+v, want skipped [ghost-att]", ack)
	}
	retry := findSkippedFrame(send("retry", body()), "chat_send_ok")
	if retry == nil || !retry.Payload.Deduplicat || len(retry.Payload.Skipped) != 1 || retry.Payload.Skipped[0] != "ghost-att" {
		t.Fatalf("deduplicated ack = %+v, want skipped [ghost-att]", retry)
	}

	// Nothing skipped: the field is absent from the wire, not an empty list.
	plain := map[string]any{"content": "plain", "client_message_id": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString())}
	if ok := findSkippedFrame(send("plain", plain), "chat_send_ok"); ok == nil || ok.Payload.MessageID == 0 || ok.Payload.Skipped != nil {
		t.Fatalf("plain ack = %+v, want a message id and no skipped ids", ok)
	}
}

func TestChatSend_AckOmitsFieldWhenNothingSkipped(t *testing.T) {
	raw := ws.BuildChatSendOKForTest("req", 7, "2024-01-01T00:00:00Z", "", false, nil)
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if _, present := m["payload"].(map[string]any)["skipped_attachment_ids"]; present {
		t.Fatalf("field present when nothing skipped: %s", raw)
	}
	raw = ws.BuildChatSendOKForTest("req", 7, "2024-01-01T00:00:00Z", "", false, []string{"x"})
	if !json.Valid(raw) || !strings.Contains(string(raw), `"skipped_attachment_ids":["x"]`) {
		t.Fatalf("field missing: %s", raw)
	}
}

func TestChatSend_AllSkippedErrorCode(t *testing.T) {
	send, _ := newSkippedAttachmentFixture(t)
	for name, key := range map[string]string{"keyed": fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString()), "unkeyed": ""} {
		payload := map[string]any{"attachments": []string{"ghost-1", "ghost-2"}}
		if key != "" {
			payload["client_message_id"] = key
		}
		frames := send("all-"+name, payload)
		if findSkippedFrame(frames, "chat_send_ok") != nil {
			t.Fatalf("%s: got an ack for an all-skipped empty send", name)
		}
		e := findSkippedFrame(frames, "error")
		if e == nil || e.Payload.Code != ws.ErrCodeAttachmentsUnavailable || e.ID != "all-"+name {
			t.Fatalf("%s: error frame = %+v, want %s", name, e, ws.ErrCodeAttachmentsUnavailable)
		}
	}
}
