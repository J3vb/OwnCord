package db_test

import (
	"context"
	"testing"
)

// ─── GetAttachmentByID ──────────────────────────────────────────────────────

func TestGetAttachmentByID_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	att, err := database.GetAttachmentByID(context.Background(), "nonexistent-id")
	if err != nil {
		t.Errorf("GetAttachmentByID for nonexistent ID should return nil error, got %v", err)
	}
	if att != nil {
		t.Error("GetAttachmentByID for nonexistent ID should return nil attachment")
	}
}

func TestGetAttachmentByID_Found(t *testing.T) {
	database := openMigratedMemory(t)

	// Insert an attachment directly.
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size)
		 VALUES (?, ?, ?, ?, ?)`,
		"att-001", "photo.png", "stored-photo.png", "image/png", 12345,
	)
	if err != nil {
		t.Fatalf("inserting attachment: %v", err)
	}

	att, err := database.GetAttachmentByID(context.Background(), "att-001")
	if err != nil {
		t.Fatalf("GetAttachmentByID: %v", err)
	}
	if att.ID != "att-001" {
		t.Errorf("ID = %q, want 'att-001'", att.ID)
	}
	if att.Filename != "photo.png" {
		t.Errorf("Filename = %q, want 'photo.png'", att.Filename)
	}
	if att.MimeType != "image/png" {
		t.Errorf("MimeType = %q, want 'image/png'", att.MimeType)
	}
	if att.Size != 12345 {
		t.Errorf("Size = %d, want 12345", att.Size)
	}
	if att.MessageID != nil {
		t.Errorf("MessageID = %v, want nil (unlinked)", att.MessageID)
	}
}

// ─── LinkAttachmentsToMessage ────────────────────────────────────────────────

func TestLinkAttachmentsToMessage_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	n, err := database.LinkAttachmentsToMessage(context.Background(), 1, 1, nil)
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage(nil): %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows affected, got %d", n)
	}
}

func TestLinkAttachmentsToMessage_LinksUnlinked(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "linkuser")
	chID := seedChannel(t, database, "linkchan")
	msgID, _ := database.CreateMessage(context.Background(), chID, userID, "with attachment", nil)

	// Insert two unlinked attachments.
	for _, id := range []string{"att-a", "att-b"} {
		_, err := database.ExecContext(context.Background(),
			`INSERT INTO attachments (id, filename, stored_as, mime_type, size)
			 VALUES (?, ?, ?, ?, ?)`,
			id, "file.txt", "stored.txt", "text/plain", 100,
		)
		if err != nil {
			t.Fatalf("inserting attachment %s: %v", id, err)
		}
	}

	n, err := database.LinkAttachmentsToMessage(context.Background(), msgID, userID, []string{"att-a", "att-b"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 rows affected, got %d", n)
	}

	// Verify linkage.
	att, _ := database.GetAttachmentByID(context.Background(), "att-a")
	if att.MessageID == nil || *att.MessageID != msgID {
		t.Errorf("att-a MessageID = %v, want %d", att.MessageID, msgID)
	}
}

func TestLinkAttachmentsToMessage_SkipsAlreadyLinked(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "linkuser2")
	chID := seedChannel(t, database, "linkchan2")
	msg1, _ := database.CreateMessage(context.Background(), chID, userID, "msg1", nil)
	msg2, _ := database.CreateMessage(context.Background(), chID, userID, "msg2", nil)

	_, _ = database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, message_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-linked", "file.txt", "stored.txt", "text/plain", 100, msg1,
	)

	// Try to re-link to a different message — should skip (WHERE message_id IS NULL).
	n, err := database.LinkAttachmentsToMessage(context.Background(), msg2, userID, []string{"att-linked"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows (already linked), got %d", n)
	}
}

// TestLinkAttachmentsToMessage_OwnershipGuard locks the atomic IDOR guard
// (W1-3): the link UPDATE itself enforces ownership, so a foreign attachment
// can never be claimed, legacy NULL-uploader rows remain claimable, and
// nonexistent ids are skipped without failing the statement.
func TestLinkAttachmentsToMessage_OwnershipGuard(t *testing.T) {
	database := openMigratedMemory(t)
	owner := seedUser(t, database, "att-owner")
	other := seedUser(t, database, "att-other")
	chID := seedChannel(t, database, "att-owner-ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, owner, "attachment carrier", nil)

	if err := database.CreateAttachment(context.Background(), "att-owned", owner, "o.txt", "s-o.txt", "text/plain", 1, nil, nil); err != nil {
		t.Fatalf("CreateAttachment att-owned: %v", err)
	}
	if err := database.CreateAttachment(context.Background(), "att-foreign", other, "f.txt", "s-f.txt", "text/plain", 1, nil, nil); err != nil {
		t.Fatalf("CreateAttachment att-foreign: %v", err)
	}
	// Legacy row from before uploader tracking: uploader_id IS NULL.
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size)
		 VALUES ('att-legacy', 'l.txt', 's-l.txt', 'text/plain', 1)`,
	); err != nil {
		t.Fatalf("inserting legacy attachment: %v", err)
	}

	n, err := database.LinkAttachmentsToMessage(context.Background(), msgID, owner,
		[]string{"att-owned", "att-foreign", "att-legacy", "att-missing"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 linked (owned + legacy), got %d", n)
	}
	if att, _ := database.GetAttachmentByID(context.Background(), "att-owned"); att.MessageID == nil || *att.MessageID != msgID {
		t.Error("owner's unlinked attachment should link")
	}
	if att, _ := database.GetAttachmentByID(context.Background(), "att-foreign"); att.MessageID != nil {
		t.Error("another user's attachment must never link (IDOR guard)")
	}
	if att, _ := database.GetAttachmentByID(context.Background(), "att-legacy"); att.MessageID == nil {
		t.Error("legacy NULL-uploader attachment should be claimable")
	}
}

// TestLinkAttachmentsToMessage_SkipsLiveAvatar locks OC-0216: an attachment
// that is currently a user's live avatar (users.avatar points at it) must
// never be claimable by a message. Once message_id is set, handleServeFile's
// avatar branch becomes unreachable (it is gated on ChannelID == nil) and the
// file falls under the message's channel ACL / soft-delete state instead, so
// the avatar permanently disagrees with users.avatar about who may read it.
func TestLinkAttachmentsToMessage_SkipsLiveAvatar(t *testing.T) {
	database := openMigratedMemory(t)
	owner := seedUser(t, database, "avatar-owner")
	chID := seedChannel(t, database, "avatar-owner-ch")
	msgID, _ := database.CreateMessage(context.Background(), chID, owner, "attachment carrier", nil)

	if err := database.CreateAttachment(context.Background(), "att-avatar", owner, "a.png", "s-a.png", "image/png", 1, nil, nil); err != nil {
		t.Fatalf("CreateAttachment att-avatar: %v", err)
	}
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET avatar = ? WHERE id = ?`,
		"/api/v1/files/att-avatar", owner,
	); err != nil {
		t.Fatalf("setting avatar: %v", err)
	}

	n, err := database.LinkAttachmentsToMessage(context.Background(), msgID, owner, []string{"att-avatar"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows linked (live avatar must be skipped), got %d", n)
	}
	if att, _ := database.GetAttachmentByID(context.Background(), "att-avatar"); att.MessageID != nil {
		t.Error("live avatar attachment must never link to a message (OC-0216)")
	}
}

// ─── GetAttachmentsByMessageIDs ──────────────────────────────────────────────

func TestGetAttachmentsByMessageIDs_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	result, err := database.GetAttachmentsByMessageIDs(context.Background(), nil)
	if err != nil {
		t.Fatalf("GetAttachmentsByMessageIDs(nil): %v", err)
	}
	if len(result) != 0 {
		t.Errorf("expected empty map, got %d entries", len(result))
	}
}

func TestGetAttachmentsByMessageIDs_GroupsByMessage(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "attuser")
	chID := seedChannel(t, database, "attchan")
	msg1, _ := database.CreateMessage(context.Background(), chID, userID, "msg1", nil)
	msg2, _ := database.CreateMessage(context.Background(), chID, userID, "msg2", nil)

	// Two attachments on msg1, one on msg2.
	for _, row := range []struct {
		id    string
		msgID int64
	}{
		{"att-1a", msg1},
		{"att-1b", msg1},
		{"att-2a", msg2},
	} {
		_, err := database.ExecContext(context.Background(),
			`INSERT INTO attachments (id, filename, stored_as, mime_type, size, message_id)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			row.id, "f.txt", "s.txt", "text/plain", 50, row.msgID,
		)
		if err != nil {
			t.Fatalf("insert %s: %v", row.id, err)
		}
	}

	result, err := database.GetAttachmentsByMessageIDs(context.Background(), []int64{msg1, msg2})
	if err != nil {
		t.Fatalf("GetAttachmentsByMessageIDs: %v", err)
	}
	if len(result[msg1]) != 2 {
		t.Errorf("msg1 attachments = %d, want 2", len(result[msg1]))
	}
	if len(result[msg2]) != 1 {
		t.Errorf("msg2 attachments = %d, want 1", len(result[msg2]))
	}
	// Verify URL format.
	for _, ai := range result[msg1] {
		if ai.URL == "" {
			t.Error("attachment URL should not be empty")
		}
	}
}
