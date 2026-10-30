package db_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// pageAll walks a whole listing with the given page size, returning every row.
func pageAll(t *testing.T, f listFixture, archived bool, opts db.ThreadListOptions, size int) []db.ThreadListRow {
	t.Helper()
	var all []db.ThreadListRow
	after := db.ThreadCursor{}
	for range 50 {
		rows, err := f.db.ListThreadsBy(context.Background(), f.forum, archived, opts, after, size)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 {
			return all
		}
		all = append(all, rows...)
		after = rows[len(rows)-1].Cursor()
	}
	t.Fatal("paging did not finish")
	return nil
}

// The counts a list row carries are the live user messages of its thread, the
// same numbers GetThread reports, on every page and in every filter.
func TestListThreadsBy_RowsCarryCountsAcrossTiesNullActivityTagsAndArchive(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	p := f.posts // p[0] oldest ... p[3] newest
	extra := f.insertPost(t, f.forum)
	nullAct := f.insertPost(t, f.forum)
	f.must(t, `UPDATE channels SET thread_last_activity_at = NULL WHERE id = ?`, nullAct)

	post := func(channel int64, n int) {
		for range n {
			if _, err := f.db.CreateMessage(ctx, channel, f.user, "m", nil); err != nil {
				t.Fatal(err)
			}
		}
	}
	post(p[0], 3)
	post(p[1], 1)
	post(p[2], 5)
	post(extra, 2)
	post(nullAct, 4)
	// A deleted message and a non-user message are not counted.
	id, err := f.db.CreateMessage(ctx, p[2], f.user, "gone", nil)
	if err != nil {
		t.Fatal(err)
	}
	f.must(t, `UPDATE messages SET deleted = 1 WHERE id = ?`, id)
	f.must(t, `INSERT INTO messages (channel_id, user_id, content, kind) VALUES (?, ?, 'call', 1)`, p[1], f.user)

	const tie = "2026-06-06T06:06:06Z"
	f.activity(t, p[1], tie)
	f.activity(t, p[2], tie) // ties p[1]
	f.activity(t, extra, tie)
	f.activity(t, p[3], "2026-07-01T00:00:00Z")
	f.activity(t, p[0], "2026-01-01T00:00:00Z")
	f.tagPost(t, p[2], f.bug)
	f.tagPost(t, nullAct, f.bug)
	f.tagPost(t, p[0], f.ask)
	f.must(t, `UPDATE channels SET thread_archived = 1 WHERE id = ?`, p[1])

	cases := []struct {
		name     string
		archived bool
		opts     db.ThreadListOptions
		want     []int64
	}{
		{"open", false, db.ThreadListOptions{}, []int64{p[3], extra, p[2], p[0], nullAct}},
		{"open created", false, db.ThreadListOptions{Sort: db.ThreadSortCreated}, []int64{nullAct, extra, p[3], p[2], p[0]}},
		{"archived", true, db.ThreadListOptions{}, []int64{p[1]}},
		{"tag bug", false, db.ThreadListOptions{TagIDs: []int64{f.bug}}, []int64{p[2], nullAct}},
		{"tag bug or ask", false, db.ThreadListOptions{TagIDs: []int64{f.bug, f.ask}}, []int64{p[2], p[0], nullAct}},
	}
	for _, c := range cases {
		for _, size := range []int{1, 2, 10} {
			rows := pageAll(t, f, c.archived, c.opts, size)
			if !slices.Equal(idsOf(rows), c.want) {
				t.Fatalf("%s size %d: ids %v, want %v", c.name, size, idsOf(rows), c.want)
			}
			for _, r := range rows {
				want, err := f.db.GetThread(ctx, r.ID)
				if err != nil || want == nil {
					t.Fatalf("GetThread(%d): %v", r.ID, err)
				}
				if r.MessageCount != want.MessageCount || (r.LastMessageAt == nil) != (want.LastMessageAt == nil) ||
					(r.LastMessageAt != nil && *r.LastMessageAt != *want.LastMessageAt) {
					t.Errorf("%s size %d thread %d: count %d last %v, want %d %v",
						c.name, size, r.ID, r.MessageCount, r.LastMessageAt, want.MessageCount, want.LastMessageAt)
				}
			}
		}
	}

	open := pageAll(t, f, false, db.ThreadListOptions{}, 2)
	byID := map[int64]db.ThreadListRow{}
	for _, r := range open {
		byID[r.ID] = r
	}
	if byID[p[2]].MessageCount != 5 || byID[p[0]].MessageCount != 4 || byID[nullAct].MessageCount != 4 {
		t.Errorf("counts p2=%d p0=%d null=%d, want 5 4 4", byID[p[2]].MessageCount, byID[p[0]].MessageCount, byID[nullAct].MessageCount)
	}
	// A thread with no activity time sorts last and reports an empty activity.
	if last := open[len(open)-1]; last.ID != nullAct || last.Activity != "" {
		t.Errorf("last row = %d activity %q, want the null-activity thread with an empty one", last.ID, last.Activity)
	}
}

// The first page of a big forum costs the page, not the forum: asking for 10
// rows must be far cheaper than asking for all of them, because the message
// counts are only worked out for the rows shown. Compared against the same
// query's own full run so the check does not depend on the machine's speed.
func TestListThreadsBy_PageCostDoesNotGrowWithForumSize(t *testing.T) {
	if testing.Short() {
		t.Skip("seeds 16k messages")
	}
	f := newForumFixture(t)
	ctx := context.Background()
	const threads, perThread = 400, 40
	f.must(t, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
		INSERT INTO channels (name, type, parent_channel_id, thread_owner_id, thread_last_activity_at)
		SELECT 'p' || i, 'thread', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 1700000000 + i) FROM n`,
		threads, f.forum, f.user)
	f.must(t, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
		INSERT INTO messages (channel_id, user_id, content, timestamp)
		SELECT c.id, ?, 'x', '2026-01-01 00:00:00' FROM channels c, n
		WHERE c.type = 'thread' AND c.parent_channel_id = ?`, perThread, f.user, f.forum)

	median := func(limit int) time.Duration {
		runs := make([]time.Duration, 0, 5)
		for range 5 {
			start := time.Now()
			rows, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{}, db.ThreadCursor{}, limit)
			if err != nil || len(rows) == 0 {
				t.Fatalf("limit %d: %d rows, %v", limit, len(rows), err)
			}
			runs = append(runs, time.Since(start))
		}
		slices.Sort(runs)
		return runs[len(runs)/2]
	}
	page, full := median(10), median(threads+10)
	t.Logf("page of 10: %v, whole forum: %v", page, full)
	if page*4 > full {
		t.Errorf("a 10-row page took %v against %v for all %d threads: the counts are worked out for rows that are not shown", page, full, threads)
	}
}
