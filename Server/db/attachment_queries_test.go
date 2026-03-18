package db_test

import (
	"testing"
)

// ─── GetAttachmentByID ──────────────────────────────────────────────────────

func TestGetAttachmentByID_NotFound(t *testing.T) {
	database := openMigratedMemory(t)

	_, err := database.GetAttachmentByID("nonexistent-id")
	if err == nil {
		t.Error("GetAttachmentByID for nonexistent ID should return error")
	}
}

func TestGetAttachmentByID_Found(t *testing.T) {
	database := openMigratedMemory(t)

	// Insert an attachment directly.
	_, err := database.Exec(
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size)
		 VALUES (?, ?, ?, ?, ?)`,
		"att-001", "photo.png", "stored-photo.png", "image/png", 12345,
	)
	if err != nil {
		t.Fatalf("inserting attachment: %v", err)
	}

	att, err := database.GetAttachmentByID("att-001")
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

	n, err := database.LinkAttachmentsToMessage(1, nil)
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
	msgID, _ := database.CreateMessage(chID, userID, "with attachment", nil)

	// Insert two unlinked attachments.
	for _, id := range []string{"att-a", "att-b"} {
		_, err := database.Exec(
			`INSERT INTO attachments (id, filename, stored_as, mime_type, size)
			 VALUES (?, ?, ?, ?, ?)`,
			id, "file.txt", "stored.txt", "text/plain", 100,
		)
		if err != nil {
			t.Fatalf("inserting attachment %s: %v", id, err)
		}
	}

	n, err := database.LinkAttachmentsToMessage(msgID, []string{"att-a", "att-b"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 2 {
		t.Errorf("expected 2 rows affected, got %d", n)
	}

	// Verify linkage.
	att, _ := database.GetAttachmentByID("att-a")
	if att.MessageID == nil || *att.MessageID != msgID {
		t.Errorf("att-a MessageID = %v, want %d", att.MessageID, msgID)
	}
}

func TestLinkAttachmentsToMessage_SkipsAlreadyLinked(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "linkuser2")
	chID := seedChannel(t, database, "linkchan2")
	msg1, _ := database.CreateMessage(chID, userID, "msg1", nil)
	msg2, _ := database.CreateMessage(chID, userID, "msg2", nil)

	_, _ = database.Exec(
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, message_id)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		"att-linked", "file.txt", "stored.txt", "text/plain", 100, msg1,
	)

	// Try to re-link to a different message — should skip (WHERE message_id IS NULL).
	n, err := database.LinkAttachmentsToMessage(msg2, []string{"att-linked"})
	if err != nil {
		t.Fatalf("LinkAttachmentsToMessage: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 rows (already linked), got %d", n)
	}
}

// ─── GetAttachmentsByMessageIDs ──────────────────────────────────────────────

func TestGetAttachmentsByMessageIDs_Empty(t *testing.T) {
	database := openMigratedMemory(t)

	result, err := database.GetAttachmentsByMessageIDs(nil)
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
	msg1, _ := database.CreateMessage(chID, userID, "msg1", nil)
	msg2, _ := database.CreateMessage(chID, userID, "msg2", nil)

	// Two attachments on msg1, one on msg2.
	for _, row := range []struct {
		id    string
		msgID int64
	}{
		{"att-1a", msg1},
		{"att-1b", msg1},
		{"att-2a", msg2},
	} {
		_, err := database.Exec(
			`INSERT INTO attachments (id, filename, stored_as, mime_type, size, message_id)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			row.id, "f.txt", "s.txt", "text/plain", 50, row.msgID,
		)
		if err != nil {
			t.Fatalf("insert %s: %v", row.id, err)
		}
	}

	result, err := database.GetAttachmentsByMessageIDs([]int64{msg1, msg2})
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
