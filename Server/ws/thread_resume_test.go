package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// thread_changed names its channel only as payload.thread.parent_id.
func TestPayloadChannelID_ThreadChangedUsesTheParent(t *testing.T) {
	frame := buildThreadChanged(&db.ThreadInfo{ID: 9, ParentID: 4, Name: "t"})
	if got := payloadChannelID(frame); got != 4 {
		t.Fatalf("payloadChannelID(thread_changed) = %d, want the parent 4", got)
	}
	if got := payloadChannelID(buildThreadDeleted(5, 9)); got != 5 {
		t.Fatalf("payloadChannelID(thread_deleted) = %d, want 5", got)
	}
	if got := payloadChannelID([]byte(`{"type":"x","payload":{}}`)); got != 0 {
		t.Fatalf("payloadChannelID(no channel) = %d, want 0", got)
	}
}

// A thread_changed missed while disconnected is replayed on resume, like any
// other frame of a readable parent.
func TestReconnect_ReplaysThreadChanged(t *testing.T) {
	database := newTeardownTestDB(t)
	ctx := context.Background()

	userID, err := database.CreateUser(ctx, "resume-thread-user", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	parent, err := database.CreateChannel(ctx, "resume-parent", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)

	rb := hub.ReplayBuffer()
	rb.Push(98, parent, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(parent)+`,"content":"pre"}}`))
	rb.Push(99, parent, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(parent)+`,"content":"anchor"}}`))
	changed := buildThreadChanged(&db.ThreadInfo{ID: 77, ParentID: parent, Name: "RENAMED-WHILE-AWAY"})
	var stamped map[string]any
	if err := json.Unmarshal(changed, &stamped); err != nil {
		t.Fatalf("unmarshal thread_changed: %v", err)
	}
	stamped["seq"] = 100
	withSeq, _ := json.Marshal(stamped)
	rb.Push(100, parent, withSeq)

	for _, evt := range dialAndResume(t, hub, token, 99) {
		if strings.Contains(string(evt), "RENAMED-WHILE-AWAY") {
			return
		}
	}
	t.Fatal("resume dropped a thread_changed for a readable parent")
}
