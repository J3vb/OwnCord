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
	voiceID := mustCreateChannel(t, database, "call", "voice", "", "", 0)
	msgID := mustCreateMessage(t, database, voiceID, userID, "from the call", nil)

	counts, err := database.GetChannelUnreadCounts(ctx, userID)
	mustDo(t, "GetChannelUnreadCounts", err)
	cu, ok := counts[voiceID]
	if !ok {
		t.Fatalf("voice channel %d missing from unread counts", voiceID)
	}
	if cu.LastMessageID != msgID || cu.UnreadCount != 1 {
		t.Errorf("voice counts = {last:%d unread:%d}, want {last:%d unread:1}", cu.LastMessageID, cu.UnreadCount, msgID)
	}
}
