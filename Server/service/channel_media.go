package service

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/J3vb/OwnCord/Server/db"
)

// MediaStore is the slice of the database a channel's media gallery reads
// beyond Store.
type MediaStore interface {
	ListChannelMedia(ctx context.Context, q db.ChannelMediaQuery) ([]db.ChannelMediaItem, error)
	ChannelMediaBuckets(ctx context.Context, q db.ChannelMediaQuery) ([]db.MediaBucket, error)
}

var _ MediaStore = (*db.DB)(nil)

// Gallery page bounds and the longest file name search.
const (
	MediaPageDefaultLimit = 60
	MediaPageMaxLimit     = 100
	MediaNameMaxLen       = 100
	maxMediaCursorLen     = 100
)

// ChannelMediaRequest is one gallery call. Kind is db.MediaKindMedia (also
// for "") or db.MediaKindFiles. Month ("YYYY-MM", read in TZ) starts the walk
// at that month and is ignored when Cursor is set. Cursor is a previous
// page's NextCursor.
type ChannelMediaRequest struct {
	Kind       string
	Name       string
	UploaderID int64
	Oldest     bool
	Month      string
	TZ         string
	Cursor     string
	Limit      int
}

// ChannelMediaPage is one page of a channel's media. NextCursor is "" on the
// last page.
type ChannelMediaPage struct {
	Items      []db.ChannelMediaItem `json:"items"`
	NextCursor string                `json:"next_cursor"`
}

// MediaMonth is how many items one local calendar month holds.
type MediaMonth struct {
	Month string `json:"month"`
	Count int    `json:"count"`
}

// ListChannelMedia returns one page of the attachments in a channel the caller
// may read, behind the same gate as the message history.
func (s *messageReads) ListChannelMedia(ctx context.Context, userID, channelID int64, in ChannelMediaRequest) (page ChannelMediaPage, err error) {
	if s.media == nil {
		return ChannelMediaPage{}, fmt.Errorf("%w: the media gallery is not available", ErrInternal)
	}
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return ChannelMediaPage{}, err
	}
	q, err := mediaQuery(userID, channelID, in)
	if err != nil {
		return ChannelMediaPage{}, err
	}
	if in.Cursor != "" {
		cur, cerr := ParseMediaCursor(in.Cursor)
		if cerr != nil {
			return ChannelMediaPage{}, cerr
		}
		q.Cursor = cur
	} else if in.Month != "" {
		loc, lerr := loadSearchLocation(in.TZ)
		if lerr != nil {
			return ChannelMediaPage{}, lerr
		}
		start, next, merr := parseMediaMonth(in.Month, loc)
		if merr != nil {
			return ChannelMediaPage{}, merr
		}
		q.From = next
		if q.Oldest {
			q.From = start
		}
	}
	limit := in.Limit
	if limit <= 0 {
		limit = MediaPageDefaultLimit
	}
	limit = min(limit, MediaPageMaxLimit)
	q.Limit = limit + 1

	items, err := s.media.ListChannelMedia(ctx, q)
	if err != nil {
		return ChannelMediaPage{}, fmt.Errorf("%w: list channel media: %w", ErrInternal, err)
	}
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		page.NextCursor = FormatMediaCursor(db.MediaCursor{MessageID: last.MessageID, AttachmentID: last.Attachment.ID})
	}
	page.Items = items
	return page, nil
}

// ChannelMediaMonths counts a channel's media per calendar month in the
// caller's zone, newest month first, with the same filters as the list.
func (s *messageReads) ChannelMediaMonths(ctx context.Context, userID, channelID int64, in ChannelMediaRequest) (months []MediaMonth, err error) {
	if s.media == nil {
		return nil, fmt.Errorf("%w: the media gallery is not available", ErrInternal)
	}
	if err := s.requireChannelRead(ctx, userID, channelID); err != nil {
		return nil, err
	}
	q, err := mediaQuery(userID, channelID, in)
	if err != nil {
		return nil, err
	}
	loc, err := loadSearchLocation(in.TZ)
	if err != nil {
		return nil, err
	}
	buckets, err := s.media.ChannelMediaBuckets(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("%w: count channel media: %w", ErrInternal, err)
	}
	return foldMediaMonths(buckets, loc), nil
}

// mediaQuery validates the filters shared by the list and the month counts.
func mediaQuery(userID, channelID int64, in ChannelMediaRequest) (q db.ChannelMediaQuery, err error) {
	kind := in.Kind
	switch kind {
	case "":
		kind = db.MediaKindMedia
	case db.MediaKindMedia, db.MediaKindFiles:
	default:
		return db.ChannelMediaQuery{}, fmt.Errorf("%w: kind must be media or files", ErrBadRequest)
	}
	name := strings.TrimSpace(in.Name)
	if utf8.RuneCountInString(name) > MediaNameMaxLen {
		return db.ChannelMediaQuery{}, fmt.Errorf("%w: q is at most %d characters", ErrBadRequest, MediaNameMaxLen)
	}
	if in.UploaderID < 0 {
		return db.ChannelMediaQuery{}, fmt.Errorf("%w: from must be a positive user id", ErrBadRequest)
	}
	return db.ChannelMediaQuery{
		ChannelID:  channelID,
		ViewerID:   userID,
		Kind:       kind,
		Name:       name,
		UploaderID: in.UploaderID,
		Oldest:     in.Oldest,
	}, nil
}

// foldMediaMonths sums quarter-hour buckets into local months, newest first.
func foldMediaMonths(buckets []db.MediaBucket, loc *time.Location) []MediaMonth {
	byMonth := map[string]int{}
	for _, b := range buckets {
		byMonth[b.Start.In(loc).Format("2006-01")] += b.Count
	}
	months := make([]MediaMonth, 0, len(byMonth))
	for m, n := range byMonth {
		months = append(months, MediaMonth{Month: m, Count: n})
	}
	slices.SortFunc(months, func(a, b MediaMonth) int { return strings.Compare(b.Month, a.Month) })
	return months
}

// parseMediaMonth reads "YYYY-MM" as local midnight on the 1st in loc and
// returns that instant and the next month's.
func parseMediaMonth(val string, loc *time.Location) (start, next time.Time, err error) {
	t, perr := time.Parse("2006-01", val)
	if perr != nil || t.Year() < 1 || t.Year() > 9998 {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: month must be YYYY-MM", ErrBadRequest)
	}
	start = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, loc)
	next = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, loc)
	return start, next, nil
}

// FormatMediaCursor renders a cursor as "<message id>_<attachment id>".
func FormatMediaCursor(c db.MediaCursor) string {
	return strconv.FormatInt(c.MessageID, 10) + "_" + c.AttachmentID
}

// ParseMediaCursor reads a next_cursor value back.
func ParseMediaCursor(raw string) (db.MediaCursor, error) {
	bad := fmt.Errorf("%w: cursor must be a next_cursor value from a previous page", ErrBadRequest)
	if len(raw) > maxMediaCursorLen {
		return db.MediaCursor{}, bad
	}
	idText, att, found := strings.Cut(raw, "_")
	if !found || att == "" {
		return db.MediaCursor{}, bad
	}
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id < 1 {
		return db.MediaCursor{}, bad
	}
	for _, r := range att {
		if r != '-' && (r < '0' || r > '9') && (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') {
			return db.MediaCursor{}, bad
		}
	}
	return db.MediaCursor{MessageID: id, AttachmentID: att}, nil
}
