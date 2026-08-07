package db_test

import (
	"context"
	"testing"
	"time"
)

// migrations/030 changes attachments.message_id from ON DELETE CASCADE to
// ON DELETE SET NULL. Before it, deleting a channel took the whole
// channels -> messages -> attachments cascade and destroyed the attachment
// rows — the only handle DeleteOrphanedAttachments has on the stored files —
// so the uploaded bytes were stranded on disk with nothing left that could
// ever find them. After it, the same delete unlinks the row instead, and the
// existing orphan sweep reclaims the file on its next tick.
//
// This is the structural fix for the whole attachment-orphan family: the
// admin channel delete exercised here, the last leave from a group DM, and
// account deletion emptying a 1:1 DM all reach the same cascade.
func TestAdminDeleteChannel_UnlinksAttachmentsForReclaim(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)

	userID := seedUser(t, database, "cascade-uploader")
	chID := seedChannel(t, database, "doomed-channel")

	if err := database.CreateAttachment(
		ctx, "att-cascade-1", userID, "file.txt", "stored-cascade.txt", "text/plain", 100, nil, nil,
	); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, chID, userID, "with attachment", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, userID, []string{"att-cascade-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	// Precondition: the attachment is linked, so the sweep must not touch it.
	if att, err := database.GetAttachmentByID(ctx, "att-cascade-1"); err != nil || att == nil {
		t.Fatalf("precondition: attachment should exist before the delete (err=%v)", err)
	}

	if err := database.AdminDeleteChannel(ctx, chID); err != nil {
		t.Fatalf("AdminDeleteChannel: %v", err)
	}

	// The row must SURVIVE the cascade — that is the whole point. Under the
	// old ON DELETE CASCADE it was gone here and the file became unreachable.
	att, err := database.GetAttachmentByID(ctx, "att-cascade-1")
	if err != nil {
		t.Fatalf("GetAttachmentByID after channel delete: %v", err)
	}
	if att == nil {
		t.Fatal("attachment row was destroyed by the channel-delete cascade — its file is now unreclaimable on disk")
	}

	// ...and it must now look like an ordinary orphan, so the existing sweep
	// reclaims it and reports the stored filename for unlinking from disk.
	files, err := database.DeleteOrphanedAttachments(ctx, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 1 || files[0] != "stored-cascade.txt" {
		t.Fatalf("orphan sweep returned %v, want exactly [stored-cascade.txt]", files)
	}

	if att, err := database.GetAttachmentByID(ctx, "att-cascade-1"); err != nil || att != nil {
		t.Fatalf("sweep should have removed the row after reclaiming the file (att=%v err=%v)", att, err)
	}
}
