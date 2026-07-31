package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/owncord/server/db/dbgen"
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
	UploaderID *int64
}

// AttachmentAccess holds attachment metadata plus the channel context needed
// for access control. ChannelID and ChannelType are empty when the attachment
// is unlinked (message_id IS NULL or the message/channel was deleted).
type AttachmentAccess struct {
	Attachment
	ChannelID   *int64
	ChannelType string
}

// CreateAttachment inserts a new attachment record (initially unlinked to any message).
// uploaderID records who uploaded the file for ownership checks on unlinked files.
// width and height are optional image dimensions (pass nil for non-image files).
func (d *DB) CreateAttachment(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error {
	if err := d.q.CreateAttachment(ctx, dbgen.CreateAttachmentParams{
		ID:         id,
		UploaderID: &uploaderID,
		Filename:   filename,
		StoredAs:   storedAs,
		MimeType:   mimeType,
		Size:       size,
		Width:      ptrItoI64(width),
		Height:     ptrItoI64(height),
	}); err != nil {
		return fmt.Errorf("CreateAttachment: %w", err)
	}
	return nil
}

// GetAttachmentByID returns the attachment with the given ID, or nil if not found.
func (d *DB) GetAttachmentByID(ctx context.Context, id string) (*Attachment, error) {
	r, err := d.q.GetAttachmentByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentByID: %w", err)
	}
	return &Attachment{
		ID:         r.ID,
		MessageID:  r.MessageID,
		Filename:   r.Filename,
		StoredAs:   r.StoredAs,
		MimeType:   r.MimeType,
		Size:       r.Size,
		UploadedAt: r.UploadedAt,
		UploaderID: r.UploaderID,
	}, nil
}

// GetAttachmentWithChannel returns the attachment plus the channel context
// (channel ID and type) for access-control checks. Returns nil if the
// attachment does not exist. ChannelID/ChannelType are nil/empty when the
// attachment is unlinked or its message/channel was deleted.
func (d *DB) GetAttachmentWithChannel(ctx context.Context, id string) (*AttachmentAccess, error) {
	r, err := d.q.GetAttachmentWithChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentWithChannel: %w", err)
	}
	return &AttachmentAccess{
		Attachment: Attachment{
			ID:         r.ID,
			MessageID:  r.MessageID,
			Filename:   r.Filename,
			StoredAs:   r.StoredAs,
			MimeType:   r.MimeType,
			Size:       r.Size,
			UploadedAt: r.UploadedAt,
			UploaderID: r.UploaderID,
		},
		ChannelID:   r.ChannelID,
		ChannelType: derefString(r.Type),
	}, nil
}

// LinkAttachmentsToMessage sets message_id on attachments that are currently
// unlinked (message_id IS NULL) and owned by uploaderID. Legacy rows with
// uploader_id IS NULL are treated as unowned and may be claimed by any
// sender. Rows that are already linked, owned by another user, or
// nonexistent are skipped rather than errors, so a client retry of a
// partially-completed send cannot fail the whole message. This single UPDATE
// is the atomic attachment-IDOR guard for message sends: ownership is
// enforced in the same statement that links, so there is no check-then-link
// race. Returns the number of rows updated.
func (d *DB) LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) (int64, error) {
	if len(attachmentIDs) == 0 {
		return 0, nil
	}

	placeholders := make([]string, len(attachmentIDs))
	args := make([]any, 0, len(attachmentIDs)+2)
	args = append(args, messageID)
	for i, id := range attachmentIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}
	args = append(args, uploaderID)

	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`UPDATE attachments SET message_id = ?
		 WHERE id IN (%s) AND message_id IS NULL
		   AND (uploader_id = ? OR uploader_id IS NULL)`,
		strings.Join(placeholders, ","),
	)
	res, err := d.writer.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("LinkAttachmentsToMessage: %w", err)
	}
	return res.RowsAffected()
}

// GetAttachmentsByMessageIDs returns attachments grouped by message ID.
func (d *DB) GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]AttachmentInfo, error) {
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
	rows, err := d.reader.QueryContext(ctx, query, args...)
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

// DeleteOrphanedAttachments atomically removes attachment records where
// message_id IS NULL and uploaded_at is older than the given cutoff time
// string (ISO 8601). Returns the stored_as filenames of deleted records
// so the caller can remove files.
//
// BUG-132: Uses DELETE ... RETURNING to make select+delete atomic,
// preventing a race where an attachment linked between SELECT and DELETE
// would have its file deleted while the DB row survives.
func (d *DB) DeleteOrphanedAttachments(ctx context.Context, cutoff string) ([]string, error) {
	files, err := d.q.DeleteOrphanedAttachments(ctx, cutoff)
	if err != nil {
		return nil, fmt.Errorf("DeleteOrphanedAttachments: %w", err)
	}
	return files, nil
}
