package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// countedMention posts a message from author in channel 1 that names the
// given readers and raises their badges, as the send path does.
func countedMention(t *testing.T, database *db.DB, author int64, content string, readers []int64) int64 {
	t.Helper()
	ctx := context.Background()
	msg, err := database.CreateMessageWithMentions(ctx, 1, author, content, nil, readers, 0, false, nil)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, 1, msg.ID, readers); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	return msg.ID
}

// deleteAndReverse soft-deletes msgID and reverses its badges, in the order
// MessageService.DeleteMessage runs them.
func deleteAndReverse(t *testing.T, database *db.DB, msgID int64) map[int64]int64 {
	t.Helper()
	ctx := context.Background()
	if err := database.DeleteMessage(ctx, msgID, 1, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	lowered, err := database.DecrementMentionCounts(ctx, 1, []int64{msgID})
	if err != nil {
		t.Fatalf("DecrementMentionCounts: %v", err)
	}
	return lowered
}

func mentionCount(t *testing.T, database *db.DB, userID int64) int {
	t.Helper()
	n, err := database.GetMentionCount(context.Background(), userID, 1)
	if err != nil {
		t.Fatalf("GetMentionCount: %v", err)
	}
	return n
}

// An edit that adds @bob never raises his badge, so deleting the edited
// message must not take away the badge an earlier message raised.
func TestDecrementMentionCounts_EditAddedMentionKeepsOtherBadge(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	countedMention(t, database, 1, "@bob hi", []int64{2})
	edited := countedMention(t, database, 1, "hello", nil)
	if _, err := database.ReplaceMessageMentions(ctx, edited, []int64{2}, false, nil); err != nil {
		t.Fatalf("ReplaceMessageMentions: %v", err)
	}
	if n := mentionCount(t, database, 2); n != 1 {
		t.Fatalf("precondition: bob mention_count = %d, want 1", n)
	}

	lowered := deleteAndReverse(t, database, edited)
	if len(lowered) != 0 {
		t.Errorf("lowered readers = %v, want none (the edited message never raised a badge)", lowered)
	}
	if n := mentionCount(t, database, 2); n != 1 {
		t.Errorf("bob mention_count = %d, want 1 (the first message is still unread)", n)
	}
}

// An edit that removes @bob leaves the badge it raised in place, so deleting
// the message must still take that badge back.
func TestDecrementMentionCounts_EditRemovedMentionStillReversed(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msgID := countedMention(t, database, 1, "@bob hi", []int64{2})
	if _, err := database.ReplaceMessageMentions(ctx, msgID, nil, false, nil); err != nil {
		t.Fatalf("ReplaceMessageMentions: %v", err)
	}

	lowered := deleteAndReverse(t, database, msgID)
	if got, ok := lowered[2]; !ok || got != 0 {
		t.Errorf("lowered = %v, want bob lowered to 0", lowered)
	}
	if n := mentionCount(t, database, 2); n != 0 {
		t.Errorf("bob mention_count = %d, want 0 (badge for a deleted message)", n)
	}
}

// @everyone stores no message_mentions row per reader; the receipt is what
// lets the delete take the badge back.
func TestDecrementMentionCounts_ReversesEveryoneBadge(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msg, err := database.CreateMessageWithMentions(ctx, 1, 1, "@everyone lunch", nil, nil, 0, true, nil)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, 1, msg.ID, []int64{2, 3}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	lowered := deleteAndReverse(t, database, msg.ID)
	if len(lowered) != 2 {
		t.Errorf("lowered = %v, want bob and carol", lowered)
	}
	for _, uid := range []int64{2, 3} {
		if n := mentionCount(t, database, uid); n != 0 {
			t.Errorf("user %d mention_count = %d, want 0", uid, n)
		}
	}
}

// The reversal consumes the message's receipts, so a second reversal of the
// same message (a retried purge batch, two removal paths) lowers nothing.
func TestDecrementMentionCounts_RepeatLowersNothing(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	first := countedMention(t, database, 1, "@bob one", []int64{2})
	countedMention(t, database, 3, "@bob two", []int64{2})

	deleteAndReverse(t, database, first)
	if ids := receiptMessageIDs(t, database, 2, 1); slices.Contains(ids, first) {
		t.Errorf("receipts after reversal = %v, still holds %d", ids, first)
	}
	lowered, err := database.DecrementMentionCounts(ctx, 1, []int64{first})
	if err != nil {
		t.Fatalf("DecrementMentionCounts (repeat): %v", err)
	}
	if len(lowered) != 0 {
		t.Errorf("repeat lowered = %v, want none", lowered)
	}
	if n := mentionCount(t, database, 2); n != 1 {
		t.Errorf("bob mention_count = %d, want 1 (the second message is still unread)", n)
	}
}

// A receipt the migration 063 backfill wrote for an @here message never
// matched a raised badge, so deleting that message must not lower the badge
// a real mention raised. The backfill's receipts are the ones on messages
// older than the migration.
func TestDecrementMentionCounts_BackfilledReceiptNeedsDirectMention(t *testing.T) {
	database := openMigratedMemory(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	countedMention(t, database, 3, "@bob real", []int64{2})
	here, err := database.CreateMessageWithMentions(ctx, 1, 1, "@here old", nil, nil, 0, true, nil)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE messages SET timestamp = '2020-01-01 00:00:00' WHERE id = ?`, here.ID); err != nil {
		t.Fatalf("age message: %v", err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO mention_receipts (user_id, channel_id, message_id) VALUES (2, 1, ?)`, here.ID); err != nil {
		t.Fatalf("seed backfilled receipt: %v", err)
	}

	lowered := deleteAndReverse(t, database, here.ID)
	if len(lowered) != 0 {
		t.Errorf("lowered = %v, want none (the backfilled receipt is not backed by a mention)", lowered)
	}
	if n := mentionCount(t, database, 2); n != 1 {
		t.Errorf("bob mention_count = %d, want 1 (the real mention is still unread)", n)
	}
}
