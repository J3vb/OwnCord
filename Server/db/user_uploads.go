package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Sort orders of a user's own upload list.
const (
	UploadSortNewest  = "newest"
	UploadSortLargest = "largest"
)

// What an upload is doing right now. The last three are in use: the file is a
// live avatar, profile banner or group DM icon, and removing it would break that
// surface, so it cannot be removed from the list.
const (
	UploadStateMessage   = "message"
	UploadStateDeleted   = "deleted"
	UploadStatePending   = "pending"
	UploadStateAvatar    = "avatar"
	UploadStateBanner    = "banner"
	UploadStateGroupIcon = "group_icon"
)

// OwnUploadCursor is where a page of the list stops: the last item's upload time
// (newest first) or size (largest first), and its id. The zero value is the
// first page.
type OwnUploadCursor struct {
	UploadedAt string
	Size       int64
	ID         string
}

// OwnUploadQuery is one request for the files userID uploaded. Every value
// reaches SQL as a bound argument; only fixed fragments are concatenated.
type OwnUploadQuery struct {
	UserID int64
	// Sort is UploadSortNewest or UploadSortLargest.
	Sort string
	// Name keeps files whose name contains it, ASCII case-insensitive.
	Name   string
	Cursor OwnUploadCursor
	Limit  int
}

// OwnUpload is one file in the list. ChannelID and MessageID are set while a
// message holds the file (a deleted message included) and nil otherwise.
type OwnUpload struct {
	Attachment AttachmentInfo `json:"attachment"`
	UploadedAt string         `json:"uploaded_at"`
	ChannelID  *int64         `json:"channel_id"`
	MessageID  *int64         `json:"message_id"`
	State      string         `json:"state"`
	Removable  bool           `json:"removable"`
}

// RemovedAttachment is what a removal took out: the stored file name for the
// caller to delete from disk, the message that held the file, and its size.
type RemovedAttachment struct {
	StoredAs  string
	MessageID *int64
	Size      int64
}

// attachmentNotInUse is the shared "not a live avatar, group DM icon or profile
// banner" guard, kept in one text so no site can name one and forget another. a is
// the attachments alias.
const attachmentNotInUse = `NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar = '/api/v1/files/' || a.id)
		   AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.dm_icon = a.id)
		   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.banner_id = a.id)`

// ListOwnUploads returns up to q.Limit of the user's attachment rows: newest
// first (upload time, then id) or largest first (size, then id). Every row the
// user uploaded counts, linked to a live message or not.
func (d *DB) ListOwnUploads(ctx context.Context, q OwnUploadQuery) ([]OwnUpload, error) {
	if q.Limit < 1 {
		return []OwnUpload{}, nil
	}
	var (
		sb   strings.Builder
		args = []any{q.UserID}
		set  = q.Cursor.ID != ""
	)
	if q.Name != "" {
		sb.WriteString(` AND a.filename LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Name)+"%")
	}
	var order string
	switch q.Sort {
	case UploadSortNewest:
		order = " ORDER BY a.uploaded_at DESC, a.id DESC"
		if set {
			sb.WriteString(" AND (a.uploaded_at < ? OR (a.uploaded_at = ? AND a.id < ?))")
			args = append(args, q.Cursor.UploadedAt, q.Cursor.UploadedAt, q.Cursor.ID)
		}
	case UploadSortLargest:
		order = " ORDER BY a.size DESC, a.id DESC"
		if set {
			sb.WriteString(" AND (a.size < ? OR (a.size = ? AND a.id < ?))")
			args = append(args, q.Cursor.Size, q.Cursor.Size, q.Cursor.ID)
		}
	default:
		return nil, fmt.Errorf("ListOwnUploads: unknown sort %q", q.Sort)
	}
	args = append(args, q.Limit)

	//nolint:gosec // G202: the filter and order are fixed fragments with ? placeholders
	query := `SELECT a.id, a.filename, a.size, a.mime_type, a.width, a.height, a.duration_ms, a.waveform,
		        a.uploaded_at, a.message_id, m.channel_id,
		        CASE
		          WHEN EXISTS (SELECT 1 FROM users u WHERE u.avatar = '/api/v1/files/' || a.id) THEN 'avatar'
		          WHEN EXISTS (SELECT 1 FROM users u WHERE u.banner_id = a.id) THEN 'banner'
		          WHEN EXISTS (SELECT 1 FROM channels c WHERE c.dm_icon = a.id) THEN 'group_icon'
		          WHEN a.message_id IS NULL THEN 'pending'
		          WHEN m.deleted = 1 THEN 'deleted'
		          ELSE 'message'
		        END
		 FROM attachments a
		 LEFT JOIN messages m ON m.id = a.message_id
		 WHERE a.uploader_id = ?` + sb.String() + order + ` LIMIT ?`

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListOwnUploads: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	items := []OwnUpload{}
	for rows.Next() {
		var it OwnUpload
		ai := &it.Attachment
		if err := rows.Scan(&ai.ID, &ai.Filename, &ai.Size, &ai.Mime, &ai.Width, &ai.Height, &ai.DurationMs, &ai.Waveform,
			&it.UploadedAt, &it.MessageID, &it.ChannelID, &it.State); err != nil {
			return nil, fmt.Errorf("ListOwnUploads scan: %w", err)
		}
		ai.URL = "/api/v1/files/" + ai.ID
		it.Removable = it.State == UploadStateMessage || it.State == UploadStateDeleted || it.State == UploadStatePending
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListOwnUploads rows: %w", err)
	}
	return items, nil
}

// DeleteOwnAttachment removes userID's attachment row for id in one statement,
// unless it is a live avatar, group DM icon or profile banner, and returns what
// it removed. found is false when no row matched: unknown, someone else's, or in
// use (OwnAttachmentInUse tells the last apart). RETURNING makes the delete and
// the read atomic, so of two callers racing on one row exactly one gets it.
func (d *DB) DeleteOwnAttachment(ctx context.Context, id string, userID int64) (removed RemovedAttachment, found bool, err error) {
	err = d.writer.QueryRowContext(ctx,
		`DELETE FROM attachments AS a
		 WHERE a.id = ? AND a.uploader_id = ?
		   AND `+attachmentNotInUse+`
		 RETURNING stored_as, message_id, size`, id, userID).
		Scan(&removed.StoredAs, &removed.MessageID, &removed.Size)
	if errors.Is(err, sql.ErrNoRows) {
		return RemovedAttachment{}, false, nil
	}
	if err != nil {
		return RemovedAttachment{}, false, fmt.Errorf("DeleteOwnAttachment: %w", err)
	}
	return removed, true, nil
}

// OwnAttachmentInUse reports whether userID has an attachment row for id
// (exists) and whether it is a live avatar, group DM icon or profile banner
// (inUse). Someone else's row reads as absent.
func (d *DB) OwnAttachmentInUse(ctx context.Context, id string, userID int64) (inUse, exists bool, err error) {
	err = d.reader.QueryRowContext(ctx,
		`SELECT NOT (`+attachmentNotInUse+`)
		 FROM attachments a WHERE a.id = ? AND a.uploader_id = ?`, id, userID).Scan(&inUse)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("OwnAttachmentInUse: %w", err)
	}
	return inUse, true, nil
}

// AttachmentStoredNameInUse reports whether any attachment row still names the
// stored file storedAs.
func (d *DB) AttachmentStoredNameInUse(ctx context.Context, storedAs string) (bool, error) {
	var n int
	err := d.reader.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM attachments WHERE stored_as = ?)`, storedAs).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("AttachmentStoredNameInUse: %w", err)
	}
	return n == 1, nil
}

// ErrMessageNotEmpty means DeleteEmptyOwnMessage found the message live but no
// longer empty: text or a file arrived after the caller looked.
var ErrMessageNotEmpty = errors.New("message is not empty")

// DeleteEmptyOwnMessage soft-deletes userID's ordinary message when, in the same
// statement, it still has no text and no attached file: the author branch of
// DeleteMessage plus that guard, so an edit or upload landing between the
// caller's read and this write keeps the message. It returns ErrNotFound when the
// message is missing, already deleted or someone else's, and ErrMessageNotEmpty
// when the guard refused.
func (d *DB) DeleteEmptyOwnMessage(ctx context.Context, id, userID int64) error {
	res, err := d.writer.ExecContext(ctx,
		`UPDATE messages SET deleted = 1
		 WHERE id = ? AND user_id = ? AND deleted = 0 AND kind = 0
		   AND TRIM(content) = ''
		   AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = messages.id)`, id, userID)
	if err != nil {
		return fmt.Errorf("DeleteEmptyOwnMessage: %w", err)
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return nil
	}
	msg, err := d.GetMessage(ctx, id)
	if err != nil {
		return fmt.Errorf("DeleteEmptyOwnMessage: %w", err)
	}
	if msg == nil || msg.Deleted || msg.UserID != userID || msg.Kind != MessageKindUser {
		return fmt.Errorf("DeleteEmptyOwnMessage: message %d: %w", id, ErrNotFound)
	}
	return fmt.Errorf("DeleteEmptyOwnMessage: message %d: %w", id, ErrMessageNotEmpty)
}
