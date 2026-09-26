package db_test

import (
	"context"
	"testing"
)

// OC-0323: mark_read / channel_focus read the channel's newest message id, and
// two round trips later wrote it back with `mention_count = 0`. A mention
// raised in that window — for a message NEWER than the snapshot — was wiped by
// that blind write, leaving the row saying "you have read up to 100, and you
// have no mentions" while message 101 mentioned the user and was unread. The
// badge was gone and nothing ever recomputed it; the sibling writer
// IncrementMentionCounts had been given an atomic guard for the mirror-image
// race, the clearing side had none.
//
// The invariant these tests pin is the one the pathology violates: a cleared
// mention_count must never sit behind an unread mentioning message. It is
// checked here rather than through a goroutine interleaving because the
// pathological state is exactly reachable by hand — commit the mention after
// the snapshot is taken, then mark read.

func TestMarkChannelReadAtLatest_KeepsAMentionRaisedAfterTheSnapshot(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reader := seedUser(t, database, "read-state-reader")
	author := seedUser(t, database, "read-state-author")
	chID := seedChannel(t, database, "read-state-ch")

	// The channel already has history the reader has seen.
	var lastSeen int64
	for range 3 {
		id, err := database.CreateMessage(ctx, chID, author, "old", nil)
		if err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
		lastSeen = id
	}

	// Step 1 of the race: the focus path reads the newest id it can see.
	snapshot, err := database.GetLatestMessageID(ctx, chID)
	if err != nil {
		t.Fatalf("GetLatestMessageID: %v", err)
	}
	if snapshot != lastSeen {
		t.Fatalf("snapshot = %d, want the newest message %d", snapshot, lastSeen)
	}

	// Step 2: a message mentioning the reader commits while the focus path is
	// still in flight, and the send path's background goroutine raises the
	// mention. Its own guard passes, because the reader is behind this message.
	mentioning, err := database.CreateMessage(ctx, chID, author, "@reader ping", nil)
	if err != nil {
		t.Fatalf("CreateMessage (mentioning): %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, mentioning, []int64{reader}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	// Step 3: the focus path performs its write. It must not clear the mention
	// while leaving the reader behind the message that raised it.
	if err := database.MarkChannelReadAtLatest(ctx, reader, chID); err != nil {
		t.Fatalf("MarkChannelReadAtLatest: %v", err)
	}

	lastRead, mentions, found, err := database.GetReadState(ctx, reader, chID)
	if err != nil || !found {
		t.Fatalf("GetReadState: %v (found=%v)", err, found)
	}
	if mentions == 0 && lastRead < mentioning {
		t.Errorf("read state is (last_message_id=%d, mention_count=%d): the mention for message %d was cleared "+
			"while the reader is still behind it — the badge is gone and nothing recomputes it",
			lastRead, mentions, mentioning)
	}
	// The consistent outcome: the mark-read covered the new message too,
	// because it was committed before the write ran.
	if lastRead != mentioning {
		t.Errorf("last_message_id = %d, want %d (the newest message at write time)", lastRead, mentioning)
	}
}

// The other direction still holds: a mention raised AFTER the mark-read
// survives, because IncrementMentionCounts' guard sees the reader behind it.
func TestMarkChannelReadAtLatest_LaterMentionStillCounts(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reader := seedUser(t, database, "later-reader")
	author := seedUser(t, database, "later-author")
	chID := seedChannel(t, database, "later-ch")

	if _, err := database.CreateMessage(ctx, chID, author, "old", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.MarkChannelReadAtLatest(ctx, reader, chID); err != nil {
		t.Fatalf("MarkChannelReadAtLatest: %v", err)
	}

	mentioning, err := database.CreateMessage(ctx, chID, author, "@reader later", nil)
	if err != nil {
		t.Fatalf("CreateMessage (mentioning): %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, chID, mentioning, []int64{reader}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	_, mentions, found, err := database.GetReadState(ctx, reader, chID)
	if err != nil || !found {
		t.Fatalf("GetReadState: %v (found=%v)", err, found)
	}
	if mentions != 1 {
		t.Errorf("mention_count = %d, want 1 — a mention raised after the mark-read must survive it", mentions)
	}
}

// A mark-read on a channel with no messages is a no-op watermark of 0, not an
// error and not a row that claims to have read something.
func TestMarkChannelReadAtLatest_EmptyChannel(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	reader := seedUser(t, database, "empty-reader")
	chID := seedChannel(t, database, "empty-ch")

	if err := database.MarkChannelReadAtLatest(ctx, reader, chID); err != nil {
		t.Fatalf("MarkChannelReadAtLatest: %v", err)
	}
	lastRead, mentions, found, err := database.GetReadState(ctx, reader, chID)
	if err != nil || !found {
		t.Fatalf("GetReadState: %v (found=%v)", err, found)
	}
	if lastRead != 0 || mentions != 0 {
		t.Errorf("read state = (%d, %d), want (0, 0)", lastRead, mentions)
	}
}
