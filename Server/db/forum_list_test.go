package db_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// listFixture is a forum with two tags and four posts, built with explicit
// activity times so the orders under test are not clock-dependent.
type listFixture struct {
	forumFixture
	bug, ask int64
	posts    []int64 // creation order, oldest first
}

func newListFixture(t *testing.T) listFixture {
	t.Helper()
	f := listFixture{forumFixture: newForumFixture(t)}
	tags, err := f.db.ReplaceForumSettings(context.Background(), f.forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 4320,
		Tags:                      []db.ForumTagWrite{{ID: f.tag, Name: "bug"}, {Name: "ask"}},
	})
	if err != nil || len(tags) != 2 {
		t.Fatalf("tags: %v, %v", tags, err)
	}
	f.bug, f.ask = tags[0].ID, tags[1].ID
	// The fixture's own post is the oldest; give it an old activity time.
	f.must(t, `UPDATE channels SET thread_last_activity_at = '2026-01-01T00:00:00Z' WHERE id = ?`, f.post)
	f.posts = []int64{f.post}
	for range 3 {
		f.posts = append(f.posts, f.insertPost(t, f.forum))
	}
	return f
}

func (f listFixture) activity(t *testing.T, post int64, at string) {
	t.Helper()
	f.must(t, `UPDATE channels SET thread_last_activity_at = ? WHERE id = ?`, at, post)
}

func (f listFixture) tagPost(t *testing.T, post int64, tags ...int64) {
	t.Helper()
	for _, tag := range tags {
		f.must(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, post, tag)
	}
}

func idsOf(rows []db.ThreadListRow) []int64 {
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.ID)
	}
	return out
}

func TestListThreadsBy_SortOrders(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	p := f.posts
	f.activity(t, p[1], "2026-03-01T00:00:00Z")
	f.activity(t, p[2], "2026-02-01T00:00:00Z")
	f.activity(t, p[3], "2026-04-01T00:00:00Z")

	act, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{}, db.ThreadCursor{}, 10)
	if err != nil || !slices.Equal(idsOf(act), []int64{p[3], p[1], p[2], p[0]}) {
		t.Fatalf("activity order = %v, %v", idsOf(act), err)
	}
	cre, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{Sort: db.ThreadSortCreated}, db.ThreadCursor{}, 10)
	if err != nil || !slices.Equal(idsOf(cre), []int64{p[3], p[2], p[1], p[0]}) {
		t.Fatalf("created order = %v, %v", idsOf(cre), err)
	}
	// Both sorts keep the post block.
	if cre[0].Post == nil {
		t.Error("created-sort row lacks its post block")
	}
}

func TestListThreadsBy_TagFilterAnyOfAndForeignTag(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	p := f.posts
	f.tagPost(t, p[0], f.bug)
	f.tagPost(t, p[1], f.ask)
	f.tagPost(t, p[2], f.bug, f.ask)
	for _, sort := range []string{"", db.ThreadSortCreated} {
		only, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{Sort: sort, TagIDs: []int64{f.ask}}, db.ThreadCursor{}, 10)
		if err != nil || !slices.Equal(idsOf(only), []int64{p[2], p[1]}) {
			t.Fatalf("sort %q tag ask = %v, %v", sort, idsOf(only), err)
		}
		// Any-of, and a duplicated id changes nothing.
		both, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{Sort: sort, TagIDs: []int64{f.bug, f.ask, f.bug}}, db.ThreadCursor{}, 10)
		if err != nil || len(both) != 3 || slices.Contains(idsOf(both), p[3]) {
			t.Fatalf("sort %q any-of = %v, %v", sort, idsOf(both), err)
		}
	}
	// A tag of another forum, and an id that is no tag, are unknown.
	other, err := f.db.CreateChannel(ctx, "other", "forum", "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := f.db.ReplaceForumSettings(ctx, other, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 4320, Tags: []db.ForumTagWrite{{Name: "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []int64{foreign[0].ID, 987654} {
		if _, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{TagIDs: []int64{bad}}, db.ThreadCursor{}, 10); !errors.Is(err, db.ErrForumTagUnknown) {
			t.Errorf("tag %d: err = %v, want ErrForumTagUnknown", bad, err)
		}
	}
}

// Edge case 1: posts whose activity falls in the same second page without a
// gap or a repeat, because id breaks the tie, in either sort and with a filter.
func TestListThreadsBy_PagingAcrossIdenticalActivitySeconds(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	const same = "2026-05-05T05:05:05Z"
	for _, id := range f.posts {
		f.activity(t, id, same)
		f.tagPost(t, id, f.bug)
	}
	want := slices.Clone(f.posts)
	slices.Reverse(want) // id DESC
	for _, sort := range []string{"", db.ThreadSortCreated} {
		for _, tags := range [][]int64{nil, {f.bug}} {
			var got []int64
			after := db.ThreadCursor{}
			for range 10 {
				rows, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{Sort: sort, TagIDs: tags}, after, 2)
				if err != nil {
					t.Fatal(err)
				}
				if len(rows) == 0 {
					break
				}
				got = append(got, idsOf(rows)...)
				after = rows[len(rows)-1].Cursor()
			}
			if !slices.Equal(got, want) {
				t.Fatalf("sort %q tags %v: paged %v, want %v", sort, tags, got, want)
			}
		}
	}
}

func TestListThreadsBy_ArchivedStateAndEmptyTagResult(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	f.tagPost(t, f.posts[1], f.bug)
	f.must(t, `UPDATE channels SET thread_archived = 1 WHERE id = ?`, f.posts[1])
	open, err := f.db.ListThreadsBy(ctx, f.forum, false, db.ThreadListOptions{TagIDs: []int64{f.bug}}, db.ThreadCursor{}, 10)
	if err != nil || len(open) != 0 {
		t.Fatalf("open tagged = %v, %v", idsOf(open), err)
	}
	arch, err := f.db.ListThreadsBy(ctx, f.forum, true, db.ThreadListOptions{Sort: db.ThreadSortCreated, TagIDs: []int64{f.bug}}, db.ThreadCursor{}, 10)
	if err != nil || !slices.Equal(idsOf(arch), []int64{f.posts[1]}) {
		t.Fatalf("archived tagged = %v, %v", idsOf(arch), err)
	}
}

// A text channel's threads list as before, in both sorts.
func TestListThreadsBy_TextParentUnchanged(t *testing.T) {
	f := newListFixture(t)
	ctx := context.Background()
	for _, sort := range []string{"", db.ThreadSortCreated} {
		rows, err := f.db.ListThreadsBy(ctx, f.text, false, db.ThreadListOptions{Sort: sort}, db.ThreadCursor{}, 10)
		if err != nil || !slices.Equal(idsOf(rows), []int64{f.textThrd}) || rows[0].Post != nil {
			t.Fatalf("sort %q text = %v, %v", sort, idsOf(rows), err)
		}
	}
}
