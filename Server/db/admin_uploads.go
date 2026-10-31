package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// File kinds the admin Storage page filters by, read from the sniffed MIME type.
const (
	UploadKindImage = "image"
	UploadKindVideo = "video"
	UploadKindAudio = "audio"
	UploadKindOther = "other"
)

// uploadKindSQL is the CASE that sorts an attachment row (alias a) into one
// of the kinds above. One text, so the filter and the totals never disagree.
const uploadKindSQL = `CASE
	WHEN a.mime_type LIKE 'image/%' THEN 'image'
	WHEN a.mime_type LIKE 'video/%' THEN 'video'
	WHEN a.mime_type LIKE 'audio/%' THEN 'audio'
	ELSE 'other' END`

// AdminUploadQuery is one page of every upload on the server. Zero values mean
// "any". Every value reaches SQL as a bound argument.
type AdminUploadQuery struct {
	// Sort is UploadSortNewest or UploadSortLargest.
	Sort string
	// Name keeps files whose name contains it, ASCII case-insensitive.
	Name string
	// Kind is one of the UploadKind values, or "" for every kind.
	Kind       string
	UploaderID int64
	ChannelID  int64
	// Before keeps files uploaded before this UTC time ("YYYY-MM-DD HH:MM:SS").
	Before string
	Cursor OwnUploadCursor
	Limit  int
}

// AdminUpload is one file on the admin Storage page. UploaderID and Uploader
// are empty for a legacy row with no uploader. ChannelName is left out of a
// direct message, whose name is a member list, not a channel.
type AdminUpload struct {
	Attachment  AttachmentInfo `json:"attachment"`
	UploadedAt  string         `json:"uploaded_at"`
	UploaderID  *int64         `json:"uploader_id"`
	Uploader    string         `json:"uploader"`
	ChannelID   *int64         `json:"channel_id"`
	ChannelName string         `json:"channel_name,omitempty"`
	ChannelType string         `json:"channel_type,omitempty"`
	MessageID   *int64         `json:"message_id"`
	State       string         `json:"state"`
	Removable   bool           `json:"removable"`
}

// UploadKindTotal is how many files of one kind the server holds and their bytes.
type UploadKindTotal struct {
	Kind  string `json:"kind"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// AdminRemovedAttachment is what an admin removal took out: RemovedAttachment
// plus who uploaded it (nil for a legacy row) and its name for the audit log.
type AdminRemovedAttachment struct {
	RemovedAttachment
	UploaderID *int64
	Filename   string
}

// MemberStorage is one member's counted upload bytes and own limit. QuotaMB is
// nil when the member follows the server-wide limit, 0 for no limit.
type MemberStorage struct {
	UserID    int64  `json:"user_id"`
	BytesUsed int64  `json:"bytes_used"`
	QuotaMB   *int64 `json:"quota_mb"`
}

// adminUploadFilter appends the WHERE fragments and arguments of q's filters.
func adminUploadFilter(q AdminUploadQuery, sb *strings.Builder, args []any) []any {
	if q.Name != "" {
		sb.WriteString(` AND a.filename LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Name)+"%")
	}
	if q.Kind != "" {
		sb.WriteString(" AND " + uploadKindSQL + " = ?")
		args = append(args, q.Kind)
	}
	if q.UploaderID != 0 {
		sb.WriteString(" AND a.uploader_id = ?")
		args = append(args, q.UploaderID)
	}
	if q.ChannelID != 0 {
		sb.WriteString(" AND m.channel_id = ?")
		args = append(args, q.ChannelID)
	}
	if q.Before != "" {
		sb.WriteString(" AND datetime(a.uploaded_at) < datetime(?)")
		args = append(args, q.Before)
	}
	return args
}

// ListAllUploads returns up to q.Limit attachment rows of every member, newest
// or largest first, with the same states and removable rule as the own list.
func (d *DB) ListAllUploads(ctx context.Context, q AdminUploadQuery) ([]AdminUpload, error) {
	if q.Limit < 1 {
		return []AdminUpload{}, nil
	}
	var sb strings.Builder
	args := adminUploadFilter(q, &sb, nil)
	set := q.Cursor.ID != ""
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
		return nil, fmt.Errorf("ListAllUploads: unknown sort %q", q.Sort)
	}
	args = append(args, q.Limit)

	//nolint:gosec // G202: the filter and order are fixed fragments with ? placeholders
	query := `SELECT a.id, a.filename, a.size, a.mime_type, a.width, a.height, a.duration_ms, a.waveform,
		        a.uploaded_at, a.uploader_id, COALESCE(u.username, ''), a.message_id, m.channel_id,
		        COALESCE(c.name, ''), COALESCE(c.type, ''),
		        CASE
		          WHEN EXISTS (SELECT 1 FROM users u2 WHERE u2.avatar = '/api/v1/files/' || a.id) THEN 'avatar'
		          WHEN EXISTS (SELECT 1 FROM users u2 WHERE u2.banner_id = a.id) THEN 'banner'
		          WHEN EXISTS (SELECT 1 FROM channels c2 WHERE c2.dm_icon = a.id) THEN 'group_icon'
		          WHEN a.message_id IS NULL THEN 'pending'
		          WHEN m.deleted = 1 THEN 'deleted'
		          ELSE 'message'
		        END
		 FROM attachments a
		 LEFT JOIN users u ON u.id = a.uploader_id
		 LEFT JOIN messages m ON m.id = a.message_id
		 LEFT JOIN channels c ON c.id = m.channel_id
		 WHERE 1 = 1` + sb.String() + order + ` LIMIT ?`

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListAllUploads: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	items := []AdminUpload{}
	for rows.Next() {
		var it AdminUpload
		ai := &it.Attachment
		if err := rows.Scan(&ai.ID, &ai.Filename, &ai.Size, &ai.Mime, &ai.Width, &ai.Height, &ai.DurationMs, &ai.Waveform,
			&it.UploadedAt, &it.UploaderID, &it.Uploader, &it.MessageID, &it.ChannelID,
			&it.ChannelName, &it.ChannelType, &it.State); err != nil {
			return nil, fmt.Errorf("ListAllUploads scan: %w", err)
		}
		ai.URL = "/api/v1/files/" + ai.ID
		if it.ChannelType == "dm" {
			it.ChannelName = ""
		}
		it.Removable = it.State == UploadStateMessage || it.State == UploadStateDeleted || it.State == UploadStatePending
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListAllUploads rows: %w", err)
	}
	return items, nil
}

// UploadTotals counts every attachment row and its bytes, per kind.
func (d *DB) UploadTotals(ctx context.Context) ([]UploadKindTotal, error) {
	rows, err := d.reader.QueryContext(ctx,
		`SELECT `+uploadKindSQL+` AS kind, COUNT(*), CAST(COALESCE(SUM(a.size), 0) AS INTEGER)
		 FROM attachments a GROUP BY kind ORDER BY kind`)
	if err != nil {
		return nil, fmt.Errorf("UploadTotals: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := []UploadKindTotal{}
	for rows.Next() {
		var t UploadKindTotal
		if err := rows.Scan(&t.Kind, &t.Count, &t.Bytes); err != nil {
			return nil, fmt.Errorf("UploadTotals scan: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("UploadTotals rows: %w", err)
	}
	return out, nil
}

// DeleteAttachmentByAdmin removes the attachment row id in one statement, whoever
// uploaded it, unless it is a live avatar, group DM icon or profile banner. found
// is false when no row matched: unknown, already gone or in use
// (AttachmentInUse tells the last apart). Of two callers racing on one row,
// a member's own removal included, exactly one gets it back from RETURNING.
func (d *DB) DeleteAttachmentByAdmin(ctx context.Context, id string) (removed AdminRemovedAttachment, found bool, err error) {
	err = d.writer.QueryRowContext(ctx,
		`DELETE FROM attachments AS a
		 WHERE a.id = ?
		   AND `+attachmentNotInUse+`
		 RETURNING stored_as, message_id, size, uploader_id, filename`, id).
		Scan(&removed.StoredAs, &removed.MessageID, &removed.Size, &removed.UploaderID, &removed.Filename)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminRemovedAttachment{}, false, nil
	}
	if err != nil {
		return AdminRemovedAttachment{}, false, fmt.Errorf("DeleteAttachmentByAdmin: %w", err)
	}
	return removed, true, nil
}

// AttachmentInUse reports whether a row id exists and whether it is a live
// avatar, group DM icon or profile banner.
func (d *DB) AttachmentInUse(ctx context.Context, id string) (inUse, exists bool, err error) {
	err = d.reader.QueryRowContext(ctx,
		`SELECT NOT (`+attachmentNotInUse+`) FROM attachments a WHERE a.id = ?`, id).Scan(&inUse)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("AttachmentInUse: %w", err)
	}
	return inUse, true, nil
}

// UserStorageQuotaMB reports userID's own upload limit: nil when the member
// follows the server-wide limit or has no counter row yet.
func (d *DB) UserStorageQuotaMB(ctx context.Context, userID int64) (*int64, error) {
	var q *int64
	err := d.reader.QueryRowContext(ctx, `SELECT quota_mb FROM user_storage WHERE user_id = ?`, userID).Scan(&q)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("UserStorageQuotaMB: %w", err)
	}
	return q, nil
}

// SetUserStorageQuotaMB sets userID's own upload limit (nil returns the member
// to the server-wide limit). A member with no counter row gets one, seeded from
// their attachment rows like EnsureUserStorage. found is false when no such
// user exists.
func (d *DB) SetUserStorageQuotaMB(ctx context.Context, userID int64, quotaMB *int64) (found bool, err error) {
	res, err := d.writer.ExecContext(ctx,
		`INSERT INTO user_storage (user_id, bytes_used, quota_mb)
		 SELECT u.id, (SELECT COALESCE(SUM(size), 0) FROM attachments WHERE uploader_id = u.id), ?
		   FROM users u WHERE u.id = ?
		 ON CONFLICT(user_id) DO UPDATE SET quota_mb = excluded.quota_mb`, quotaMB, userID)
	if err != nil {
		return false, fmt.Errorf("SetUserStorageQuotaMB: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("SetUserStorageQuotaMB rows: %w", err)
	}
	return n > 0, nil
}

// ListMemberStorage returns the counter rows of the given users. A user with
// no row has uploaded nothing and set no limit, and is left out.
func (d *DB) ListMemberStorage(ctx context.Context, userIDs []int64) ([]MemberStorage, error) {
	out := []MemberStorage{}
	if len(userIDs) == 0 {
		return out, nil
	}
	args := make([]any, len(userIDs))
	for i, id := range userIDs {
		args[i] = id
	}
	in := strings.TrimSuffix(strings.Repeat("?,", len(userIDs)), ",")
	//nolint:gosec // G202: `in` is "?" placeholders only; every id is bound
	rows, err := d.reader.QueryContext(ctx,
		`SELECT user_id, bytes_used, quota_mb FROM user_storage WHERE user_id IN (`+in+`) ORDER BY user_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("ListMemberStorage: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var m MemberStorage
		if err := rows.Scan(&m.UserID, &m.BytesUsed, &m.QuotaMB); err != nil {
			return nil, fmt.Errorf("ListMemberStorage scan: %w", err)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListMemberStorage rows: %w", err)
	}
	return out, nil
}
