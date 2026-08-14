package ws_test

// mentions_ready_test.go: the ready payload's per-channel mention_count and the
// chat_message broadcast's mention fields (phase 3).

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/owncord/server/ws"
)

// TestChatSend_BroadcastCarriesMentions locks that the chat_message fan-out
// ships server-resolved mention ids and the @everyone flag, so clients never
// have to re-guess them from the content.
func TestChatSend_BroadcastCarriesMentions(t *testing.T) {
	hub, database := newCoverageHub(t)
	// Mention counts are written on a background goroutine in production; run
	// them inline so this test can read GetMentionCount right after the send.
	hub.RunMentionCountsInlineForTest()
	ctx := context.Background()

	author := seedCoverageOwner(t, database, "mention-author") // owner role holds MENTION_EVERYONE
	target := seedCoverageOwner(t, database, "mention-target")
	chID := seedTestChannel(t, database, "mention-chan")

	send := make(chan []byte, 32)
	c := ws.NewTestClientWithUser(hub, author, chID, send)
	hub.Register(c)
	waitRegistered(t, hub, c)

	raw, _ := json.Marshal(map[string]any{
		"type": "chat_send",
		"payload": map[string]any{
			"channel_id": chID,
			"content":    "@everyone please review, @mention-target",
		},
	})
	hub.HandleMessageForTest(c, raw)

	var found bool
	for _, msg := range drainChanTimeout(send, 300*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Mentions         []int64 `json:"mentions"`
				MentionsEveryone bool    `json:"mentions_everyone"`
			} `json:"payload"`
		}
		if json.Unmarshal(msg, &env) != nil || env.Type != "chat_message" {
			continue
		}
		found = true
		if !env.Payload.MentionsEveryone {
			t.Error("mentions_everyone = false, want true")
		}
		if len(env.Payload.Mentions) != 1 || env.Payload.Mentions[0] != target.ID {
			t.Errorf("mentions = %v, want [%d]", env.Payload.Mentions, target.ID)
		}
	}
	if !found {
		t.Fatal("no chat_message broadcast received")
	}

	// The mentioned reader's badge went up; the author's did not.
	if n, _ := database.GetMentionCount(ctx, target.ID, chID); n != 1 {
		t.Errorf("target mention_count = %d, want 1", n)
	}
	if n, _ := database.GetMentionCount(ctx, author.ID, chID); n != 0 {
		t.Errorf("author mention_count = %d, want 0", n)
	}
}

func TestBuildReady_CarriesMentionCount(t *testing.T) {
	hub, database := newCoverageHub(t)
	ctx := context.Background()

	user := seedCoverageOwner(t, database, "mention-reader")
	role, err := database.GetRoleByID(ctx, 1)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	chID, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, 1, []int64{user.ID}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}

	var env struct {
		Payload struct {
			Channels []struct {
				ID           int64 `json:"id"`
				MentionCount *int  `json:"mention_count"`
			} `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	var found bool
	for _, ch := range env.Payload.Channels {
		if ch.ID != chID {
			continue
		}
		found = true
		if ch.MentionCount == nil {
			t.Fatal("channel is missing mention_count")
		}
		if *ch.MentionCount != 1 {
			t.Errorf("mention_count = %d, want 1", *ch.MentionCount)
		}
	}
	if !found {
		t.Fatalf("channel %d missing from ready payload", chID)
	}
}

// TestBuildReady_MentionCountZeroWithoutReadState locks that a channel with no
// read_states row still ships the field, so the client never sees it undefined.
func TestBuildReady_MentionCountZeroWithoutReadState(t *testing.T) {
	hub, database := newCoverageHub(t)
	ctx := context.Background()

	user := seedCoverageOwner(t, database, "mention-fresh")
	role, err := database.GetRoleByID(ctx, 1)
	if err != nil || role == nil {
		t.Fatalf("GetRoleByID: %v", err)
	}
	if _, err := database.CreateChannel(ctx, "quiet", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	msg, err := hub.BuildReadyWithRoleForTest(database, user.ID, role)
	if err != nil {
		t.Fatalf("BuildReadyWithRoleForTest: %v", err)
	}
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(msg, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Payload.Channels) == 0 {
		t.Fatal("no channels in ready payload")
	}
	for _, ch := range env.Payload.Channels {
		if _, ok := ch["mention_count"]; !ok {
			t.Errorf("text channel %v is missing mention_count", ch["id"])
		}
	}
}
