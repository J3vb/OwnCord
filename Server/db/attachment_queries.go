package db

import (
	"database/sql"
	"errors"
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

// CreateAttachment inserts a new attachment record (initially unlinked to any message).
// width and height are optional image dimensions (pass nil for non-image files).
func (d *DB) CreateAttachment(id, filename, storedAs, mimeType string, size int64, width, height *int) error {
	_, err := d.sqlDB.Exec(
		`INSERT INTO attachments (id, filename, stored_as, mime_type, size, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, filename, storedAs, mimeType, size, width, height,
	)
	if err != nil {
		return fmt.Errorf("CreateAttachment: %w", err)
	}
	return nil
}

// GetAttachmentByID returns the attachment with the given ID, or nil if not found.
func (d *DB) GetAttachmentByID(id string) (*Attachment, error) {
	row := d.sqlDB.QueryRow(
		`SELECT id, message_id, filename, stored_as, mime_type, size, uploaded_at
		 FROM attachments WHERE id = ?`, id,
	)
	a := &Attachment{}
	err := row.Scan(&a.ID, &a.MessageID, &a.Filename, &a.StoredAs, &a.MimeType, &a.Size, &a.UploadedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
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

	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
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

	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`SELECT id, message_id, filename, size, mime_type, width, height
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
		if scanErr := rows.Scan(&id, &msgID, &ai.Filename, &ai.Size, &ai.Mime, &ai.Width, &ai.Height); scanErr != nil {
			return nil, fmt.Errorf("GetAttachmentsByMessageIDs scan: %w", scanErr)
		}
		ai.ID = id
		ai.URL = "/api/v1/files/" + id
		result[msgID] = append(result[msgID], ai)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetAttachmentsByMessageIDs rows: %w", rows.Err())
	}
	return result, nil
}

// DeleteOrphanedAttachments removes attachment records where message_id IS NULL
// and uploaded_at is older than the given cutoff time string (ISO 8601).
// Returns the stored_as filenames of deleted records so the caller can remove files.
func (d *DB) DeleteOrphanedAttachments(cutoff string) ([]string, error) {
	rows, err := d.sqlDB.Query(
		`SELECT stored_as FROM attachments WHERE message_id IS NULL AND uploaded_at < ?`,
		cutoff,
	)
	if err != nil {
		return nil, fmt.Errorf("DeleteOrphanedAttachments query: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var files []string
	for rows.Next() {
		var storedAs string
		if scanErr := rows.Scan(&storedAs); scanErr != nil {
			return nil, fmt.Errorf("DeleteOrphanedAttachments scan: %w", scanErr)
		}
		files = append(files, storedAs)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("DeleteOrphanedAttachments rows: %w", rows.Err())
	}

	if len(files) > 0 {
		_, err = d.sqlDB.Exec(
			`DELETE FROM attachments WHERE message_id IS NULL AND uploaded_at < ?`,
			cutoff,
		)
		if err != nil {
			return nil, fmt.Errorf("DeleteOrphanedAttachments delete: %w", err)
		}
	}

	return files, nil
}
