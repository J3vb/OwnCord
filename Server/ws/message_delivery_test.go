package ws_test

import (
	"context"
	"encoding/json"
	"fmt"
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
