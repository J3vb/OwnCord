package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// ErrSearchUnscoped is returned by SearchMessagesFiltered when the query names
// no channel. A search never falls back to "every channel": the caller always
// states the set it is allowed to read.
var ErrSearchUnscoped = errors.New("search query has no channel scope")

// SearchQuery is one filtered full-text search. Every value reaches SQL as a
// bound argument; only fixed fragments and "?" placeholders are concatenated.
type SearchQuery struct {
	// Text is the raw search words. When nothing searchable survives
	// sanitising it, the query is filter-only: no FTS driver, newest first.
	Text string
	// ChannelIDs is the required, non-empty channel scope.
	ChannelIDs []int64
	// AuthorIDs, when non-empty, keeps messages by any of these users.
	AuthorIDs []int64
	// AfterTS keeps messages with timestamp >= AfterTS; BeforeTS keeps
	// timestamp < BeforeTS. Both use the stored "YYYY-MM-DD HH:MM:SS" UTC
	// format; empty means unbounded.
	AfterTS, BeforeTS string
	// MentionIDs keeps messages that mention every one of these users in
	// their text. Reply-ping rows and @everyone do not count.
	MentionIDs []int64
	// Has keeps messages that satisfy every kind: link, file, image, video,
	// sound. Attachment kinds only see attachments linked to the message.
	Has []string
	// Pinned, when set, keeps messages whose pinned flag equals it.
	Pinned *bool
}

// HasSearchTerms reports whether text has anything left to search for once
// sanitised for FTS5.
func HasSearchTerms(text string) bool {
	return ftsMatchQuery(text) != ""
}

// SearchMessagesFiltered runs the one search query builder. Deleted messages
// are excluded. With searchable words the order is rank (or newest first when
// page.Recent); without words it is always newest first, paged by page.Before.
func (d *DB) SearchMessagesFiltered(ctx context.Context, q SearchQuery, page SearchPage) ([]MessageSearchResult, error) {
	if len(q.ChannelIDs) == 0 {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", ErrSearchUnscoped)
	}
	if page.Limit < 1 {
		return []MessageSearchResult{}, nil
	}
	match := ftsMatchQuery(q.Text)
	ranked := match != ""

	var (
		sb   strings.Builder
		args []any
	)
	sb.WriteString(`SELECT m.id, m.channel_id, c.name, u.id, u.username, u.avatar, m.content,
		        m.timestamp, m.mentions_everyone
		 FROM `)
	idCol := "m.id"
	if ranked {
		idCol = "f.rowid"
		sb.WriteString("messages_fts f JOIN messages m ON f.rowid = m.id")
	} else {
		sb.WriteString("messages m")
	}
	sb.WriteString(` JOIN channels c ON m.channel_id = c.id
		 JOIN users u ON m.user_id = u.id
		 WHERE m.deleted = 0`)
	if ranked {
		sb.WriteString(" AND messages_fts MATCH ?")
		args = append(args, match)
	}
	sb.WriteString(" AND m.channel_id IN (" + placeholders(len(q.ChannelIDs)) + ")")
	args = appendIDs(args, q.ChannelIDs)
	if len(q.AuthorIDs) > 0 {
		sb.WriteString(" AND m.user_id IN (" + placeholders(len(q.AuthorIDs)) + ")")
		args = appendIDs(args, q.AuthorIDs)
	}
	if q.AfterTS != "" {
		lo, err := d.firstIDAtOrAfter(ctx, q.AfterTS)
		if err != nil {
			return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
		}
		sb.WriteString(" AND m.id >= ? AND m.timestamp >= ?")
		args = append(args, lo, q.AfterTS)
	}
	if q.BeforeTS != "" {
		hi, err := d.firstIDAtOrAfter(ctx, q.BeforeTS)
		if err != nil {
			return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
		}
		sb.WriteString(" AND m.id < ? AND m.timestamp < ?")
		args = append(args, hi, q.BeforeTS)
	}
	extra, extraArgs, err := searchExtraFilters(q)
	if err != nil {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
	}
	sb.WriteString(extra)
	args = append(args, extraArgs...)
	tail, tailArgs := searchPageSQL(page, idCol, ranked)
	sb.WriteString(tail)
	args = append(args, tailArgs...)

	rows, err := d.reader.QueryContext(ctx, sb.String(), args...)
	if err != nil {
		return nil, fmt.Errorf("SearchMessagesFiltered: %w", err)
	}
	defer rows.Close() //nolint:errcheck

	results, err := scanSearchResults(rows, "SearchMessagesFiltered")
	if err != nil {
		return nil, err
	}
	return d.attachSearchMentions(ctx, results)
}

// firstIDAtOrAfter returns a message id b such that every message with id < b
// has a timestamp before ts and every message with id >= b may qualify. It
// binary-searches messages.id (monotonic with timestamp on every insert path)
// in about 2x20 rowid probes, so a date bound becomes an id range scan with no
// timestamp index. The caller still applies the exact timestamp predicate, so
// there are no false positives; a backward clock step can hide rows near a
// bound (accepted in the 3A-14 design, D7). Hard-deleted id gaps are
// skipped by probing for the first existing id at or above each midpoint.
func (d *DB) firstIDAtOrAfter(ctx context.Context, ts string) (int64, error) {
	var minID, maxID sql.NullInt64
	if err := d.reader.QueryRowContext(ctx, `SELECT MIN(id), MAX(id) FROM messages`).Scan(&minID, &maxID); err != nil {
		return 0, fmt.Errorf("firstIDAtOrAfter bounds: %w", err)
	}
	if !minID.Valid || !maxID.Valid {
		return 0, nil
	}
	lo, hi := minID.Int64, maxID.Int64+1
	for lo < hi {
		mid := lo + (hi-lo)/2
		var id int64
		var rowTS string
		err := d.reader.QueryRowContext(ctx,
			`SELECT id, timestamp FROM messages WHERE id >= ? ORDER BY id LIMIT 1`, mid).Scan(&id, &rowTS)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			hi = mid
		case err != nil:
			return 0, fmt.Errorf("firstIDAtOrAfter probe: %w", err)
		case rowTS >= ts:
			hi = mid
		default:
			lo = id + 1
		}
	}
	return lo, nil
}

// allChannelIDs lists every channel id, for the legacy unscoped SearchMessages.
func (d *DB) allChannelIDs(ctx context.Context) ([]int64, error) {
	rows, err := d.reader.QueryContext(ctx, `SELECT id FROM channels`)
	if err != nil {
		return nil, fmt.Errorf("allChannelIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("allChannelIDs scan: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("allChannelIDs rows: %w", err)
	}
	return ids, nil
}

// placeholders returns n comma-separated "?" markers.
func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

func appendIDs(args []any, ids []int64) []any {
	for _, id := range ids {
		args = append(args, id)
	}
	return args
}
