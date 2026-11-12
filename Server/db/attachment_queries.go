package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
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

// AttachmentAccess holds attachment metadata plus the channel context for access
// control; the channel fields are empty when the attachment is unlinked or its
// message/channel was deleted.
type AttachmentAccess struct {
	Attachment
	ChannelID      *int64
	ChannelType    string
	ChannelNSFW    bool
	ChannelPending bool
}

// CreateAttachment inserts an unlinked attachment; width and height are nil for non-images.
func (d *DB) CreateAttachment(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error {
	return d.CreateAttachmentVoice(ctx, id, uploaderID, filename, storedAs, mimeType, size, width, height, nil, nil)
}

// CreateAttachmentVoice is CreateAttachment plus duration and a base64url waveform.
func (d *DB) CreateAttachmentVoice(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height, durationMs *int, waveform *string) error {
	if err := d.q.CreateAttachment(ctx, dbgen.CreateAttachmentParams{
		ID:         id,
		UploaderID: &uploaderID,
		Filename:   filename,
		StoredAs:   storedAs,
		MimeType:   mimeType,
		Size:       size,
		Width:      ptrItoI64(width),
		Height:     ptrItoI64(height),
		DurationMs: ptrItoI64(durationMs),
		Waveform:   waveform,
	}); err != nil {
		return fmt.Errorf("CreateAttachment: %w", err)
	}
	return nil
}

// DeleteUnlinkedAttachment removes userID's still-unlinked row, reporting whether one was removed.
func (d *DB) DeleteUnlinkedAttachment(ctx context.Context, id string, userID int64) (bool, error) {
	n, err := d.q.DeleteUnlinkedAttachment(ctx, dbgen.DeleteUnlinkedAttachmentParams{ID: id, UploaderID: &userID})
	if err != nil {
		return false, fmt.Errorf("DeleteUnlinkedAttachment: %w", err)
	}
	return n > 0, nil
}

// DiscardUnlinkedAttachment removes userID's unlinked row unless a live avatar and
// returns its stored name.
func (d *DB) DiscardUnlinkedAttachment(ctx context.Context, id string, userID int64) (storedAs string, found bool, err error) {
	storedAs, err = d.q.DiscardUnlinkedAttachment(ctx, dbgen.DiscardUnlinkedAttachmentParams{ID: id, UploaderID: &userID})
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("DiscardUnlinkedAttachment: %w", err)
	}
	return storedAs, true, nil
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

// GetAttachmentWithChannel returns the attachment plus channel context for access control, or nil.
func (d *DB) GetAttachmentWithChannel(ctx context.Context, id string) (*AttachmentAccess, error) {
	r, err := d.q.GetAttachmentWithChannel(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentWithChannel: %w", err)
	}
	return &AttachmentAccess{
		ID:             r.ID,
		MessageID:      r.MessageID,
		Filename:       r.Filename,
		StoredAs:       r.StoredAs,
		MimeType:       r.MimeType,
		Size:           r.Size,
		UploadedAt:     r.UploadedAt,
		UploaderID:     r.UploaderID,
		ChannelID:      r.ChannelID,
		ChannelType:    derefString(r.Type),
		ChannelPending: r.ImportPending != nil && *r.ImportPending != 0,
		ChannelNSFW:    (r.Nsfw != nil && *r.Nsfw != 0) || (r.ParentNsfw != nil && *r.ParentNsfw != 0),
	}, nil
}

// LinkAttachmentsToMessage sets message_id on attachments that are unlinked and owned
// by uploaderID (legacy rows with uploader_id NULL may be claimed by any sender).
// Linked, foreign-owned, live-avatar or missing rows are skipped, not errors, so a
// retry of a partly completed send cannot fail the message; excluding live avatars
// keeps handleServeFile's avatar branch reachable. The single UPDATE is the atomic
// attachment-IDOR guard, with no check-then-link race. It returns the linked ids
// (RETURNING) in no guaranteed order.
func (d *DB) LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) ([]string, error) {
	return linkAttachmentsToMessage(ctx, d.writer, messageID, uploaderID, attachmentIDs)
}

// linkAttachmentsToMessage is shared by legacy and retry-safe sends so both enforce
// one ownership predicate.
func linkAttachmentsToMessage(ctx context.Context, exec attachmentLinker, messageID, uploaderID int64, attachmentIDs []string) ([]string, error) {
	if len(attachmentIDs) == 0 {
		return nil, nil
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
		   AND (uploader_id = ? OR uploader_id IS NULL)
		   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar = '/api/v1/files/' || attachments.id)
		   AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.dm_icon = attachments.id)
		   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.banner_id = attachments.id)
		 RETURNING id`,
		strings.Join(placeholders, ","),
	)
	rows, err := exec.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("LinkAttachmentsToMessage: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var linked []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("LinkAttachmentsToMessage scan: %w", err)
		}
		linked = append(linked, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("LinkAttachmentsToMessage rows: %w", err)
	}
	return linked, nil
}

type attachmentLinker interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// GetAttachmentsByMessageIDs returns attachments grouped by message ID.
func (d *DB) GetAttachmentsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]AttachmentInfo, error) {
	if len(msgIDs) == 0 {
		return map[int64][]AttachmentInfo{}, nil
	}

	rows, err := d.queryCached(ctx,
		`SELECT id, message_id, filename, size, mime_type, width, height, duration_ms, waveform
		 FROM attachments WHERE message_id IN (SELECT value FROM json_each(?))`,
		idsJSON(msgIDs),
	)
	if err != nil {
		return nil, fmt.Errorf("GetAttachmentsByMessageIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	result := make(map[int64][]AttachmentInfo)
	for rows.Next() {
		var id string
		var msgID int64
		var ai AttachmentInfo
		if scanErr := rows.Scan(&id, &msgID, &ai.Filename, &ai.Size, &ai.Mime, &ai.Width, &ai.Height, &ai.DurationMs, &ai.Waveform); scanErr != nil {
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

// DeleteOrphanedAttachments removes attachment records older than cutoff that are
// unlinked or linked to a soft-deleted message (live avatars, banners and group icons
// excluded), returning the stored_as names for the caller to remove.
// A soft delete never matches message_id IS NULL, so the second statement reclaims
// those files; two statements so each uses its own index. cutoff is a time.Time
// because uploaded_at is compared bytewise as 'YYYY-MM-DD HH:MM:SS'; RFC3339 would
// collapse the grace period to "same date". DELETE ... RETURNING keeps select+delete
// atomic. If the second statement fails the first's names come back with the error and
// the caller must still remove them.
func (d *DB) DeleteOrphanedAttachments(ctx context.Context, cutoff time.Time) ([]string, error) {
	return d.DeleteOrphanedAttachmentsBefore(ctx, cutoff, cutoff)
}

// DeleteOrphanedAttachmentsBefore is DeleteOrphanedAttachments with a cutoff per half:
// unlinkedBefore for unlinked uploads, deletedBefore for files of soft-deleted
// messages.
func (d *DB) DeleteOrphanedAttachmentsBefore(ctx context.Context, unlinkedBefore, deletedBefore time.Time) ([]string, error) {
	files, err := d.q.DeleteUnlinkedOrphanedAttachments(ctx, unlinkedBefore.UTC().Format(dbtime.SQLiteLayout))
	if err != nil {
		return nil, fmt.Errorf("DeleteOrphanedAttachments: unlinked: %w", err)
	}
	deleted, err := d.q.DeleteDeletedMessageAttachments(ctx, deletedBefore.UTC().Format(dbtime.SQLiteLayout))
	if err != nil {
		return files, fmt.Errorf("DeleteOrphanedAttachments: deleted messages: %w", err)
	}
	return append(files, deleted...), nil
}
