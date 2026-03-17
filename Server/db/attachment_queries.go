package db

import (
	"fmt"
	"strings"
)

// Attachment represents a row in the attachments table.
type Attachment struct {
	ID         string
	MessageID  *int64
	Filename   string
	StoredAs   string
	MimeType   string
	Size       int64
	UploadedAt string
}

// GetAttachmentByID returns the attachment with the given ID, or nil if not found.
func (d *DB) GetAttachmentByID(id string) (*Attachment, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, message_id, filename, stored_as, mime_type, size, uploaded_at
		 FROM attachments WHERE id = ?`, id,
	)
	a := &Attachment{}
	err := row.Scan(&a.ID, &a.MessageID, &a.Filename, &a.StoredAs, &a.MimeType, &a.Size, &a.UploadedAt)
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentByID: %w", err)
	}
	return a, nil
}

// LinkAttachmentsToMessage sets message_id on attachments that are currently
// unlinked (message_id IS NULL). Returns the number of rows updated.
// Uses WHERE message_id IS NULL to prevent double-linking in a race.
func (d *DB) LinkAttachmentsToMessage(messageID int64, attachmentIDs []string) (int64, error) {
	if len(attachmentIDs) == 0 {
		return 0, nil
	}

	placeholders := make([]string, len(attachmentIDs))
	args := make([]any, 0, len(attachmentIDs)+1)
	args = append(args, messageID)
	for i, id := range attachmentIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	query := fmt.Sprintf(
		`UPDATE attachments SET message_id = ? WHERE id IN (%s) AND message_id IS NULL`,
		strings.Join(placeholders, ","),
	)
	res, err := d.sqlDB.Exec(query, args...)
	if err != nil {
		return 0, fmt.Errorf("LinkAttachmentsToMessage: %w", err)
	}
	return res.RowsAffected()
}

// GetAttachmentsByMessageIDs returns attachments grouped by message ID.
func (d *DB) GetAttachmentsByMessageIDs(msgIDs []int64) (map[int64][]AttachmentInfo, error) {
	if len(msgIDs) == 0 {
		return map[int64][]AttachmentInfo{}, nil
	}

	placeholders := make([]string, len(msgIDs))
	args := make([]any, len(msgIDs))
	for i, id := range msgIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(
		`SELECT id, message_id, filename, size, mime_type
		 FROM attachments WHERE message_id IN (%s)`,
		strings.Join(placeholders, ","),
	)
	rows, err := d.sqlDB.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentsByMessageIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64][]AttachmentInfo)
	for rows.Next() {
		var id string
		var msgID int64
		var ai AttachmentInfo
		if scanErr := rows.Scan(&id, &msgID, &ai.Filename, &ai.Size, &ai.Mime); scanErr != nil {
			return nil, fmt.Errorf("GetAttachmentsByMessageIDs scan: %w", scanErr)
		}
		ai.ID = id
		ai.URL = "/api/v1/files/" + id
		result[msgID] = append(result[msgID], ai)
	}
	return result, nil
}
