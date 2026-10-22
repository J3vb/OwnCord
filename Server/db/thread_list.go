package db

import (
	"context"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Thread list sorts: ThreadSortActivity orders by last activity (the default),
// ThreadSortCreated by creation, both newest first.
const (
	ThreadSortActivity = "activity"
	ThreadSortCreated  = "created"
)

// ThreadListOptions narrows and orders a thread list. The zero value is the
// activity order with no tag filter.
type ThreadListOptions struct {
	// Sort is ThreadSortActivity (or "") or ThreadSortCreated. Under
	// ThreadSortCreated only After.ID is read: creation order is id order.
	Sort string
	// TagIDs, when set, keeps the posts of a forum carrying any of these tags.
	// Every id must be a tag of the parent, else ErrForumTagUnknown.
	TagIDs []int64
}

// ListThreads returns a parent's threads with the given archived state, newest
// activity first, continuing after cursor. The cursor is a value, not a thread
// id to look up, so activity in the cursor thread does not move the page.
func (d *DB) ListThreads(ctx context.Context, parentID int64, archived bool, after ThreadCursor, limit int) ([]ThreadListRow, error) {
	return d.ListThreadsBy(ctx, parentID, archived, ThreadListOptions{}, after, limit)
}

// tagList renders ids as the comma-wrapped ",1,2," the list queries match
// with instr. An empty list renders as ",".
func tagList(ids []int64) string {
	var b strings.Builder
	b.WriteByte(',')
	for _, id := range ids {
		b.WriteString(strconv.FormatInt(id, 10))
		b.WriteByte(',')
	}
	return b.String()
}

// ListThreadsBy is ListThreads with a sort and a tag filter. Under the created
// sort the cursor is just the previous page's last id. Under activity the
// order is (thread_last_activity_at DESC, id DESC): activity has one-second
// resolution, so the id breaks ties and the keyset is stable across them.
func (d *DB) ListThreadsBy(ctx context.Context, parentID int64, archived bool, opts ThreadListOptions, after ThreadCursor, limit int) ([]ThreadListRow, error) {
	tags := slices.Clone(opts.TagIDs)
	slices.Sort(tags)
	tags = slices.Compact(tags)
	if len(tags) > 0 {
		if err := requireForumTags(ctx, d.q, parentID, tags); err != nil {
			return nil, fmt.Errorf("ListThreads: %w", err)
		}
	}
	noTags := int64(1)
	if len(tags) > 0 {
		noTags = 0
	}
	var rows []ThreadListRow
	if opts.Sort == ThreadSortCreated {
		got, err := d.q.ListThreadInfosByParentCreated(ctx, dbgen.ListThreadInfosByParentCreatedParams{
			ParentID: &parentID, Archived: b2i64(archived), NoTagFilter: noTags, TagIds: tagList(tags),
			BeforeID: after.ID, RowLimit: int64(limit),
		})
		if err != nil {
			return nil, fmt.Errorf("ListThreads: %w", err)
		}
		rows = make([]ThreadListRow, 0, len(got))
		for i := range got {
			r := got[i]
			rows = append(rows, listRow(threadFields{
				ID: r.ID, ParentID: r.ParentID, Name: r.Name, ThreadOwnerID: r.ThreadOwnerID,
				ThreadStarterMessageID: r.ThreadStarterMessageID, ThreadArchived: r.ThreadArchived,
				ThreadLocked: r.ThreadLocked, ThreadAutoArchiveMinutes: r.ThreadAutoArchiveMinutes,
				MessageCount: r.MessageCount, LastMessageAt: r.LastMessageAt, CreatedAt: r.CreatedAt,
			}, r.ActivityAt))
		}
	} else {
		got, err := d.q.ListThreadInfosByParent(ctx, dbgen.ListThreadInfosByParentParams{
			ParentID: &parentID, Archived: b2i64(archived), NoTagFilter: noTags, TagIds: tagList(tags),
			BeforeID: after.ID, BeforeActivity: after.Activity, RowLimit: int64(limit),
		})
		if err != nil {
			return nil, fmt.Errorf("ListThreads: %w", err)
		}
		rows = make([]ThreadListRow, 0, len(got))
		for i := range got {
			r := got[i]
			rows = append(rows, listRow(threadFields{
				ID: r.ID, ParentID: r.ParentID, Name: r.Name, ThreadOwnerID: r.ThreadOwnerID,
				ThreadStarterMessageID: r.ThreadStarterMessageID, ThreadArchived: r.ThreadArchived,
				ThreadLocked: r.ThreadLocked, ThreadAutoArchiveMinutes: r.ThreadAutoArchiveMinutes,
				MessageCount: r.MessageCount, LastMessageAt: r.LastMessageAt, CreatedAt: r.CreatedAt,
			}, r.ActivityAt))
		}
	}
	ts := make([]*ThreadInfo, len(rows))
	for i := range rows {
		ts[i] = &rows[i].ThreadInfo
	}
	if err := attachPosts(ctx, d.q, ts); err != nil {
		return nil, fmt.Errorf("ListThreads: %w", err)
	}
	return rows, nil
}

func listRow(f threadFields, activity string) ThreadListRow {
	return ThreadListRow{ThreadInfo: threadFromFields(f), Activity: activity}
}
