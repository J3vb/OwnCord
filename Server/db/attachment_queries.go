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

// AttachmentAccess holds attachment metadata plus the channel context needed
// for access control. ChannelID and ChannelType are empty when the attachment
// is unlinked (message_id IS NULL or the message/channel was deleted).
// ChannelNSFW is meaningless in that case too (always false).
type AttachmentAccess struct {
	Attachment
	ChannelID   *int64
	ChannelType string
	ChannelNSFW bool
}

// CreateAttachment inserts a new attachment record (initially unlinked to any message).
// uploaderID records who uploaded the file for ownership checks on unlinked files.
// width and height are optional image dimensions (pass nil for non-image files).
func (d *DB) CreateAttachment(ctx context.Context, id string, uploaderID int64, filename, storedAs, mimeType string, size int64, width, height *int) error {
	return d.CreateAttachmentVoice(ctx, id, uploaderID, filename, storedAs, mimeType, size, width, height, nil, nil)
}

// CreateAttachmentVoice is CreateAttachment plus the voice message fields:
// durationMs is the clip length and waveform its canonical
// base64url (unpadded) amplitude bytes. Both are nil for any other file.
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

// DeleteUnlinkedAttachment removes userID's attachment row for id while it is
// still unlinked to a message, reporting whether a row was removed.
func (d *DB) DeleteUnlinkedAttachment(ctx context.Context, id string, userID int64) (bool, error) {
	n, err := d.q.DeleteUnlinkedAttachment(ctx, dbgen.DeleteUnlinkedAttachmentParams{ID: id, UploaderID: &userID})
	if err != nil {
		return false, fmt.Errorf("DeleteUnlinkedAttachment: %w", err)
	}
	return n > 0, nil
}

// DiscardUnlinkedAttachment removes userID's unlinked attachment row for id,
// unless it is a live avatar, and returns its stored file name. found is false
// when there was no such row.
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
		ID:          r.ID,
		MessageID:   r.MessageID,
		Filename:    r.Filename,
		StoredAs:    r.StoredAs,
		MimeType:    r.MimeType,
		Size:        r.Size,
		UploadedAt:  r.UploadedAt,
		UploaderID:  r.UploaderID,
		ChannelID:   r.ChannelID,
		ChannelType: derefString(r.Type),
		ChannelNSFW: (r.Nsfw != nil && *r.Nsfw != 0) || (r.ParentNsfw != nil && *r.ParentNsfw != 0),
	}, nil
}

// LinkAttachmentsToMessage sets message_id on attachments that are currently
// unlinked (message_id IS NULL) and owned by uploaderID. Legacy rows with
// uploader_id IS NULL are treated as unowned and may be claimed by any
// sender. Rows that are already linked, owned by another user, currently
// serving as a live avatar (users.avatar points at them), or nonexistent are
// skipped rather than errors, so a client retry of a partially-completed send
// cannot fail the whole message. Excluding live avatars keeps
// handleServeFile's avatar branch (gated on ChannelID == nil) reachable: once
// message_id is set that branch is dead and the file falls under the
// message's channel ACL / soft-delete state instead, permanently splitting
// from what users.avatar still names. This single UPDATE is the
// atomic attachment-IDOR guard for message sends: ownership is enforced in
// the same statement that links, so there is no check-then-link race.
// Returns the ids it linked (UPDATE ... RETURNING id, so the answer is atomic
// with the link), in no guaranteed order; callers diff against the request to
// learn which ids were skipped.
func (d *DB) LinkAttachmentsToMessage(ctx context.Context, messageID, uploaderID int64, attachmentIDs []string) ([]string, error) {
	return linkAttachmentsToMessage(ctx, d.writer, messageID, uploaderID, attachmentIDs)
}

// linkAttachmentsToMessage is shared by legacy sends and retry-safe sends'
// writer transaction, so both enforce the same atomic ownership predicate.
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

// attachmentLinker is the query surface linkAttachmentsToMessage needs; both
// *sql.DB (the writer) and *sql.Tx satisfy it.
type attachmentLinker interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
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
		`SELECT id, message_id, filename, size, mime_type, width, height, duration_ms, waveform
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

// DeleteOrphanedAttachments atomically removes attachment records that are
// either unlinked (message_id IS NULL) or linked to a message that has since
// been soft-deleted (messages.deleted = 1), and whose uploaded_at is older
// than the given cutoff. Live avatars are excluded by the query itself.
// Returns the stored_as filenames of deleted records so the caller can
// remove files.
//
// A message delete is a soft delete -- the messages row survives
// with deleted=1 -- so its attachments never go through message_id IS NULL
// on their own. The second half of the query's WHERE clause is what lets
// this sweep reclaim those files too, since serveFileResolve already treats
// them as unservable once the owning message is deleted.
//
// The cutoff is a time.Time, not a string, because uploaded_at is stored in
// SQLite's own 'YYYY-MM-DD HH:MM:SS' shape and the comparison is bytewise:
// a caller formatting RFC3339 instead silently collapses the grace period to
// "same date". Formatting it here is what keeps that unrepresentable.
//
// Uses DELETE ... RETURNING to make select+delete atomic,
// preventing a race where an attachment linked between SELECT and DELETE
// would have its file deleted while the DB row survives.
func (d *DB) DeleteOrphanedAttachments(ctx context.Context, cutoff time.Time) ([]string, error) {
	files, err := d.q.DeleteOrphanedAttachments(ctx, cutoff.UTC().Format(dbtime.SQLiteLayout))
	if err != nil {
		return nil, fmt.Errorf("DeleteOrphanedAttachments: %w", err)
	}
	return files, nil
}
