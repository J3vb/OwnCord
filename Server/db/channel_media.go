package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/dbtime"
)

// Channel media kinds: images and videos for the gallery grid, everything
// else (documents, audio, voice messages, archives) for the files list.
const (
	MediaKindMedia = "media"
	MediaKindFiles = "files"
)

// MediaCursor is where a media page stops: the last item's message id and
// attachment id. The zero value is the first page.
type MediaCursor struct {
	MessageID    int64
	AttachmentID string
}

// ChannelMediaQuery is one gallery request over a single channel. Every value
// reaches SQL as a bound argument; only fixed fragments are concatenated.
type ChannelMediaQuery struct {
	ChannelID int64
	// ViewerID is the caller. Media from users the caller blocked is left out.
	ViewerID int64
	// Kind is MediaKindMedia or MediaKindFiles.
	Kind string
	// Name keeps attachments whose file name contains it, ASCII case-insensitive.
	Name string
	// UploaderID keeps media posted by this user; 0 means anyone.
	UploaderID int64
	// Oldest walks oldest first; the default is newest first.
	Oldest bool
	// From, when set, is where the walk starts: newest-first keeps messages
	// sent before it, oldest-first keeps messages sent at or after it. Used by
	// "jump to month". Ignored once Cursor is set.
	From   time.Time
	Cursor MediaCursor
	Limit  int
}

// ChannelMediaItem is one attachment in the gallery with the message it
// belongs to, so a click can jump there.
type ChannelMediaItem struct {
	Attachment AttachmentInfo `json:"attachment"`
	MessageID  int64          `json:"message_id"`
	User       UserPublic     `json:"user"`
	Timestamp  string         `json:"timestamp"`
}

// MediaBucket is the attachment count in one quarter hour (UTC). The service
// folds buckets into local months; a quarter hour never straddles a month
// boundary in any zone whose offset is a multiple of 15 minutes.
type MediaBucket struct {
	Start time.Time
	Count int
}

// ListChannelMedia returns up to q.Limit attachments of one channel in message
// order (newest or oldest first), several attachments of one message in
// attachment id order. Deleted messages and unlinked uploads never appear.
func (d *DB) ListChannelMedia(ctx context.Context, q ChannelMediaQuery) ([]ChannelMediaItem, error) {
	if q.Limit < 1 {
		return []ChannelMediaItem{}, nil
	}
	filter, args, err := d.channelMediaFilter(ctx, q, true)
	if err != nil {
		return nil, fmt.Errorf("ListChannelMedia: %w", err)
	}
	// Ordering on a.message_id rather than m.id, with attachments pinned as
	// the outer loop (CROSS JOIN), walks idx_attachments_message in order and
	// sorts only the ties within one message. Left to itself, without ANALYZE
	// statistics, the planner starts from the channel's messages and sorts
	// every attachment of the channel for each page.
	order := " ORDER BY a.message_id DESC, a.id ASC"
	if q.Oldest {
		order = " ORDER BY a.message_id ASC, a.id ASC"
	}
	//nolint:gosec // G202: filter and order are fixed fragments with ? placeholders
	query := `SELECT a.id, a.filename, a.size, a.mime_type, a.width, a.height, a.duration_ms, a.waveform,
		        m.id, m.timestamp, u.id, u.username, u.avatar
		 FROM attachments a
		 CROSS JOIN messages m ON m.id = a.message_id
		 JOIN users u ON u.id = m.user_id
		 WHERE m.channel_id = ? AND m.deleted = 0 AND m.kind = 0` + filter + order + ` LIMIT ?`
	args = append([]any{q.ChannelID}, args...)
	args = append(args, q.Limit)

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ListChannelMedia: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	items := []ChannelMediaItem{}
	for rows.Next() {
		var it ChannelMediaItem
		ai := &it.Attachment
		if err := rows.Scan(&ai.ID, &ai.Filename, &ai.Size, &ai.Mime, &ai.Width, &ai.Height, &ai.DurationMs, &ai.Waveform,
			&it.MessageID, &it.Timestamp, &it.User.ID, &it.User.Username, &it.User.Avatar); err != nil {
			return nil, fmt.Errorf("ListChannelMedia scan: %w", err)
		}
		ai.URL = "/api/v1/files/" + ai.ID
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ListChannelMedia rows: %w", err)
	}
	return items, nil
}

// ChannelMediaBuckets counts the attachments matching q's kind, name, uploader
// and block filters per UTC quarter hour, oldest first. Cursor, From, Oldest
// and Limit are ignored: the counts cover the whole channel.
func (d *DB) ChannelMediaBuckets(ctx context.Context, q ChannelMediaQuery) ([]MediaBucket, error) {
	filter, args, err := d.channelMediaFilter(ctx, q, false)
	if err != nil {
		return nil, fmt.Errorf("ChannelMediaBuckets: %w", err)
	}
	//nolint:gosec // G202: filter is fixed fragments with ? placeholders
	query := `SELECT substr(m.timestamp, 1, 13), CAST(substr(m.timestamp, 15, 2) AS INTEGER) / 15, COUNT(*)
		 FROM messages m
		 JOIN attachments a ON a.message_id = m.id
		 WHERE m.channel_id = ? AND m.deleted = 0 AND m.kind = 0` + filter + `
		 GROUP BY 1, 2 ORDER BY 1, 2`
	args = append([]any{q.ChannelID}, args...)

	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("ChannelMediaBuckets: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	var buckets []MediaBucket
	for rows.Next() {
		var hour string
		var quarter, n int
		if err := rows.Scan(&hour, &quarter, &n); err != nil {
			return nil, fmt.Errorf("ChannelMediaBuckets scan: %w", err)
		}
		start, ok := dbtime.Parse(hour + ":00:00")
		if !ok {
			continue
		}
		buckets = append(buckets, MediaBucket{Start: start.Add(time.Duration(quarter) * 15 * time.Minute), Count: n})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ChannelMediaBuckets rows: %w", err)
	}
	return buckets, nil
}

// channelMediaFilter renders the kind, name, uploader and block predicates,
// and with paging the start point and cursor, as " AND ..." fragments over
// aliases m and a.
func (d *DB) channelMediaFilter(ctx context.Context, q ChannelMediaQuery, paging bool) (string, []any, error) {
	var (
		sb   strings.Builder
		args []any
	)
	const isMedia = "(a.mime_type LIKE 'image/%' OR a.mime_type LIKE 'video/%')"
	switch q.Kind {
	case MediaKindMedia:
		sb.WriteString(" AND " + isMedia)
	case MediaKindFiles:
		sb.WriteString(" AND NOT " + isMedia)
	default:
		return "", nil, fmt.Errorf("channelMediaFilter: unknown kind %q", q.Kind)
	}
	if q.Name != "" {
		sb.WriteString(` AND a.filename LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLike(q.Name)+"%")
	}
	if q.UploaderID > 0 {
		sb.WriteString(" AND m.user_id = ?")
		args = append(args, q.UploaderID)
	}
	sb.WriteString(" AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE b.blocker_id = ? AND b.blocked_id = m.user_id)")
	args = append(args, q.ViewerID)
	if !paging {
		return sb.String(), args, nil
	}

	switch {
	case q.Cursor.MessageID > 0:
		cmp := "<"
		if q.Oldest {
			cmp = ">"
		}
		sb.WriteString(" AND (a.message_id " + cmp + " ? OR (a.message_id = ? AND a.id > ?))")
		args = append(args, q.Cursor.MessageID, q.Cursor.MessageID, q.Cursor.AttachmentID)
	case !q.From.IsZero():
		ts := q.From.UTC().Format(dbtime.SQLiteLayout)
		cmp, tsCmp := "<", "<"
		if q.Oldest {
			cmp, tsCmp = ">=", ">="
		}
		imported, err := d.importedChannelIDs(ctx)
		if err != nil {
			return "", nil, err
		}
		native, importedInScope := splitImportedScope([]int64{q.ChannelID}, imported)
		if len(native) > 0 {
			bound, err := d.firstIDAtOrAfter(ctx, ts)
			if err != nil {
				return "", nil, err
			}
			// The id bound narrows the index range; the exact timestamp test
			// below decides.
			frag, fragArgs := idBound("a.message_id "+cmp, bound, native, importedInScope)
			sb.WriteString(frag)
			args = append(args, fragArgs...)
		}
		sb.WriteString(" AND m.timestamp " + tsCmp + " ?")
		args = append(args, ts)
	}
	return sb.String(), args, nil
}

// escapeLike escapes the LIKE wildcards and the escape character itself so a
// file name search matches literally.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}
