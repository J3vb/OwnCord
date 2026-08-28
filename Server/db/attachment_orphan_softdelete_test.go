package db_test

import (
	"context"
	"time"

	"testing"
)

// OC-0279: soft-deleting a message (the only kind of delete that exists —
// messages.deleted=1, row survives) leaves attachments.message_id pointing
// at the now-deleted message. DeleteOrphanedAttachments' predicate is
// `message_id IS NULL`, so such a row never matches: the attachment is
// simultaneously unservable (serveFileResolve 404s once the message is
// deleted) and unreclaimable (no sweep ever deletes the row or the file on
// disk). This test pins that the orphan sweep must reclaim attachments whose
// owning message has been soft-deleted.
func TestDeleteOrphanedAttachments_ReclaimsAttachmentOfSoftDeletedMessage(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)

	userID := seedUser(t, database, "softdelete-uploader")
	chID := seedChannel(t, database, "softdelete-channel")

	if err := database.CreateAttachment(
		ctx, "att-softdel-1", userID, "file.txt", "stored-softdel.txt", "text/plain", 100, nil, nil,
	); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, chID, userID, "with attachment", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, userID, []string{"att-softdel-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	// Soft-delete the message the attachment is linked to. Under the current
	// schema this ONLY sets messages.deleted=1 -- it does not touch the
	// attachments row, so attachments.message_id is still set afterward.
	if err := database.DeleteMessage(ctx, msgID, userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	// A generous future cutoff -- if the row is ever eligible at all, this
	// cutoff catches it. today's implementation never will, because
	// message_id IS NULL is false for this row.
	files, err := database.DeleteOrphanedAttachments(ctx, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 1 || files[0] != "stored-softdel.txt" {
		t.Fatalf("orphan sweep returned %v, want exactly [stored-softdel.txt] -- the attachment "+
			"of a soft-deleted message must be reclaimed", files)
	}

	if att, err := database.GetAttachmentByID(ctx, "att-softdel-1"); err != nil || att != nil {
		t.Fatalf("sweep should have removed the row after reclaiming the file (att=%v err=%v)", att, err)
	}
}

// Guard rail on the same fix: an attachment linked to a message that is
// still live (not deleted) must NOT be reclaimed by the sweep, no matter how
// old uploaded_at is. Without this, a predicate that over-widens (e.g.
// dropping the deleted check entirely) would start eating live attachments.
func TestDeleteOrphanedAttachments_DoesNotReclaimAttachmentOfLiveMessage(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemory(t)

	userID := seedUser(t, database, "live-uploader")
	chID := seedChannel(t, database, "live-channel")

	if err := database.CreateAttachment(
		ctx, "att-live-1", userID, "file.txt", "stored-live.txt", "text/plain", 100, nil, nil,
	); err != nil {
		t.Fatalf("CreateAttachment: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, chID, userID, "with attachment", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if n, err := database.LinkAttachmentsToMessage(ctx, msgID, userID, []string{"att-live-1"}); err != nil || n != 1 {
		t.Fatalf("LinkAttachmentsToMessage: n=%d err=%v", n, err)
	}

	files, err := database.DeleteOrphanedAttachments(ctx, time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("DeleteOrphanedAttachments: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("orphan sweep reclaimed %v, want none -- the message is still live", files)
	}
	if att, err := database.GetAttachmentByID(ctx, "att-live-1"); err != nil || att == nil {
		t.Fatalf("attachment row of a live message must survive the sweep (att=%v err=%v)", att, err)
	}
}
