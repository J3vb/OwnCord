package db_test

import (
	"context"
	"testing"
)

// WP 6.1a: a voice channel has a text chat, so its unread and mention state is
// counted like a text channel's.
func TestGetChannelUnreadCounts_IncludesVoice(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "voiceunread")
	voiceID, err := database.CreateChannel(ctx, "call", "voice", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(voice): %v", err)
	}
	msgID, err := database.CreateMessage(ctx, voiceID, userID, "from the call", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	counts, err := database.GetChannelUnreadCounts(ctx, userID)
	if err != nil {
		t.Fatalf("GetChannelUnreadCounts: %v", err)
	}
	cu, ok := counts[voiceID]
	if !ok {
		t.Fatalf("voice channel %d missing from unread counts", voiceID)
	}
	if cu.LastMessageID != msgID || cu.UnreadCount != 1 {
		t.Errorf("voice counts = {last:%d unread:%d}, want {last:%d unread:1}", cu.LastMessageID, cu.UnreadCount, msgID)
	}
}
