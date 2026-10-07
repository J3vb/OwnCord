package db_test

import (
	"context"
	"testing"
)

// A reply frame embeds its parent's snippet, so purging the parent (retention
// sweep) or erasing the parent's author must remove the reply's replay frame
// too, or the snippet stays replayable.
func TestReplayPurge_NamesTheReferencedParent(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	persistFrame(t, database, 1, 7, "chat_message", map[string]any{
		"id": 300, "channel_id": 7, "content": "re", "user": map[string]any{"id": 2},
		"referenced_message": map[string]any{"id": 100, "user": map[string]any{"id": 42}, "content": "old"},
	})
	persistFrame(t, database, 2, 7, "chat_message", map[string]any{
		"id": 301, "channel_id": 7, "content": "re", "user": map[string]any{"id": 2},
		"referenced_message": map[string]any{"id": 101, "user": map[string]any{"id": 43}, "content": "kept"},
	})

	if n, err := database.DeleteEventsForMessages(ctx, []int64{100}); err != nil || n != 1 {
		t.Fatalf("DeleteEventsForMessages = %d, %v; want the reply frame removed", n, err)
	}
	if n, err := database.DeleteEventsForUser(ctx, 43); err != nil || n != 1 {
		t.Fatalf("DeleteEventsForUser = %d, %v; want the reply frame removed", n, err)
	}
}
