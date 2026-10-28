package service

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/dbtime"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Thread list sorts (see ThreadListParams.Sort).
const (
	ThreadSortActivity = db.ThreadSortActivity
	ThreadSortCreated  = db.ThreadSortCreated
)

// ThreadListParams narrows and orders one thread list request. The zero value
// is a parent's open threads, newest activity first, no tag filter.
type ThreadListParams struct {
	// Sort is ThreadSortActivity (or "") or ThreadSortCreated.
	Sort string
	// TagIDs keeps the posts carrying any of these tags; forum parents only,
	// at most db.MaxPostTags, each a tag of that forum.
	TagIDs []int64
	// Archived lists archived threads instead of open ones.
	Archived bool
}

// List returns a channel's threads with the given archived state, gated by the
// parent's read. They come newest activity first, or newest created first
// under ThreadSortCreated. hasMore reports another page. A tag filter on a
// parent that is not a forum, or naming a tag the forum does not have, is
// ErrBadRequest.
func (s *ThreadService) List(ctx context.Context, userID, parentID int64, p ThreadListParams, after ThreadCursor, limit int) (threads []db.ThreadInfo, next ThreadCursor, hasMore bool, err error) {
	ts, err := s.store()
	if err != nil {
		return nil, ThreadCursor{}, false, err
	}
	if parentID <= 0 {
		return nil, ThreadCursor{}, false, fmt.Errorf("%w: channel_id must be positive", ErrBadRequest)
	}
	switch p.Sort {
	case "", ThreadSortActivity, ThreadSortCreated:
	default:
		return nil, ThreadCursor{}, false, fmt.Errorf("%w: sort must be activity or created", ErrBadRequest)
	}
	ch, err := s.st.GetChannel(ctx, parentID)
	if err != nil || ch == nil {
		return nil, ThreadCursor{}, false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if ch.IsThread() {
		return nil, ThreadCursor{}, false, fmt.Errorf("%w: channel not found", ErrNotFound)
	}
	if err := readContentDenial(permissions.CanReadContent(readSubject(ctx, s.st, s.perms, userID, ch))); err != nil {
		return nil, ThreadCursor{}, false, err
	}
	if len(p.TagIDs) > 0 {
		if ch.Type != "forum" {
			return nil, ThreadCursor{}, false, fmt.Errorf("%w: tag filters apply to forums only", ErrBadRequest)
		}
		if len(p.TagIDs) > db.MaxPostTags {
			return nil, ThreadCursor{}, false, fmt.Errorf("%w: at most %d tags", ErrBadRequest, db.MaxPostTags)
		}
	}
	if limit <= 0 {
		limit = ThreadListDefaultLimit
	}
	limit = min(limit, ThreadListMaxLimit)
	rows, err := ts.ListThreadsBy(ctx, parentID, p.Archived, db.ThreadListOptions{Sort: p.Sort, TagIDs: p.TagIDs}, after, limit+1)
	if err != nil {
		if errors.Is(err, db.ErrForumTagUnknown) {
			return nil, ThreadCursor{}, false, fmt.Errorf("%w: unknown tag", ErrBadRequest)
		}
		return nil, ThreadCursor{}, false, fmt.Errorf("%w: list threads: %w", ErrInternal, err)
	}
	hasMore = len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	threads = make([]db.ThreadInfo, 0, len(rows))
	for _, r := range rows {
		threads = append(threads, r.ThreadInfo)
	}
	if len(rows) > 0 {
		next = rows[len(rows)-1].Cursor()
	}
	return threads, next, hasMore, nil
}

// ThreadCursor is the position a thread list page stops at (db.ThreadCursor).
type ThreadCursor = db.ThreadCursor

// FormatThreadCursor renders a cursor as the opaque `before` value of the list
// route: the activity time and the id of the page's last row, joined by "_".
func FormatThreadCursor(c ThreadCursor) string {
	return c.Activity + "_" + strconv.FormatInt(c.ID, 10)
}

// FormatThreadCursorFor renders the `next_before` of a page in the given sort:
// the activity cursor under activity, the last row's id alone under created.
func FormatThreadCursorFor(sort string, c ThreadCursor) string {
	if sort == ThreadSortCreated {
		return strconv.FormatInt(c.ID, 10)
	}
	return FormatThreadCursor(c)
}

// ParseThreadCursorFor reads a `before` value in the given sort. A cursor from
// the other sort does not parse, so it is ErrBadRequest rather than a page
// from the wrong place.
func ParseThreadCursorFor(sort, raw string) (ThreadCursor, error) {
	if sort != ThreadSortCreated {
		return ParseThreadCursor(raw)
	}
	if raw == "" {
		return ThreadCursor{}, nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 1 {
		return ThreadCursor{}, fmt.Errorf("%w: before is not a thread cursor", ErrBadRequest)
	}
	return ThreadCursor{ID: id}, nil
}

// ParseThreadCursor reads a `before` value; "" is the first page.
func ParseThreadCursor(raw string) (ThreadCursor, error) {
	if raw == "" {
		return ThreadCursor{}, nil
	}
	activity, idText, found := strings.CutLast(raw, "_")
	if !found {
		return ThreadCursor{}, fmt.Errorf("%w: before is not a thread cursor", ErrBadRequest)
	}
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id < 1 {
		return ThreadCursor{}, fmt.Errorf("%w: before is not a thread cursor", ErrBadRequest)
	}
	if _, perr := time.Parse(dbtime.ISOLayout, activity); perr != nil && activity != "" {
		return ThreadCursor{}, fmt.Errorf("%w: before is not a thread cursor", ErrBadRequest)
	}
	return ThreadCursor{Activity: activity, ID: id}, nil
}
