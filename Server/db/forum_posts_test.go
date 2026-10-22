package db_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// postParams is a forum_post_create's delivery: ChannelID is the forum.
func postParams(user, forum int64, cmid, content string, tags ...int64) db.MessageDeliveryParams {
	hash := sha256.Sum256([]byte(cmid))
	return db.MessageDeliveryParams{
		UserID: user, ChannelID: forum, ClientMessageID: cmid, PayloadHash: hash[:], Content: content,
		ExpiresAtMS: time.Now().Add(time.Hour).UnixMilli(),
		ForumPost:   &db.ForumPostInput{Name: "a post", AutoArchiveMinutes: 4320, TagIDs: tags},
	}
}

func postCounts(t *testing.T, d *db.DB) (threads, msgs, links, receipts int) {
	t.Helper()
	ctx := context.Background()
	for q, dst := range map[string]*int{
		`SELECT COUNT(*) FROM channels WHERE type = 'thread'`: &threads,
		`SELECT COUNT(*) FROM messages`:                       &msgs,
		`SELECT COUNT(*) FROM thread_tags`:                    &links,
		`SELECT COUNT(*) FROM message_delivery_receipts`:      &receipts,
	} {
		if err := d.QueryRowContext(ctx, q).Scan(dst); err != nil {
			t.Fatal(err)
		}
	}
	return threads, msgs, links, receipts
}

// TestForumPostDelivery commits a post: the thread, its opening message, the
// pointer, the tags, the receipt and the author's read state in one commit.
func TestForumPostDelivery(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	got, err := f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, "p1", "hello forum", f.tag))
	if err != nil {
		t.Fatal(err)
	}
	if got.Thread == nil || got.Message.ChannelID != got.Thread.ID || got.Thread.ParentID != f.forum {
		t.Fatalf("delivery = %+v thread = %+v", got.Message, got.Thread)
	}
	post := got.Thread.Post
	if post == nil || post.FirstMessage == nil || post.FirstMessage.ID != got.Message.ID ||
		post.FirstMessage.Preview != "hello forum" || len(post.TagIDs) != 1 || post.TagIDs[0] != f.tag {
		t.Fatalf("post = %+v", post)
	}
	if got.Thread.StarterMessageID != nil || got.Thread.OwnerID == nil || *got.Thread.OwnerID != f.user {
		t.Fatalf("thread = %+v", got.Thread)
	}
	var last int64
	if err := f.db.QueryRowContext(ctx, `SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?`, f.user, got.Thread.ID).Scan(&last); err != nil || last != got.Message.ID {
		t.Fatalf("author read state = %d, %v", last, err)
	}

	// A retry answers from the receipt keyed on the forum, with no second post.
	again, err := f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, "p1", "hello forum", f.tag))
	if err != nil || !again.Duplicate || again.Message.ID != got.Message.ID {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	found, err := f.db.FindMessageDelivery(ctx, postParams(f.user, f.forum, "p1", "hello forum", f.tag))
	if err != nil || found == nil || !found.Duplicate {
		t.Fatalf("find = %+v, %v", found, err)
	}
}

// TestForumPostRetryAfterDelete: a deleted opening message, or a post a
// moderator deleted, answers "deleted" to the retry and recreates nothing.
func TestForumPostRetryAfterDelete(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	for name, remove := range map[string]func(post *db.MessageDelivery){
		"message soft-deleted": func(p *db.MessageDelivery) {
			if _, err := f.db.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, p.Message.ID); err != nil {
				t.Fatal(err)
			}
		},
		"post deleted": func(p *db.MessageDelivery) {
			if ok, err := f.db.DeleteThread(ctx, p.Thread.ID); err != nil || !ok {
				t.Fatalf("DeleteThread = %v, %v", ok, err)
			}
		},
	} {
		cmid := "del-" + name
		p, err := f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, cmid, "x"))
		if err != nil {
			t.Fatal(err)
		}
		remove(p)
		before, _, _, _ := postCounts(t, f.db)
		if _, err := f.db.FindMessageDelivery(ctx, postParams(f.user, f.forum, cmid, "x")); !errors.Is(err, db.ErrMessageDeliveryDeleted) {
			t.Fatalf("%s: find err = %v", name, err)
		}
		if _, err := f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, cmid, "x")); !errors.Is(err, db.ErrMessageDeliveryDeleted) {
			t.Fatalf("%s: create err = %v", name, err)
		}
		if after, _, _, _ := postCounts(t, f.db); after != before {
			t.Fatalf("%s: a retry created a post (%d -> %d threads)", name, before, after)
		}
	}
}

// TestForumPostUnknownTagWritesNothing: a refused post leaves no thread, no
// message, no link and no receipt, for an unknown tag, a duplicate id, a tag of
// another forum and a forum that is not a forum.
func TestForumPostUnknownTagWritesNothing(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	other, err := f.db.CreateChannel(ctx, "other", "forum", "", "", 5)
	if err != nil {
		t.Fatal(err)
	}
	otherTags, err := f.db.ReplaceForumSettings(ctx, other, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 60, Tags: []db.ForumTagWrite{{Name: "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	t0, m0, l0, r0 := postCounts(t, f.db)
	cases := map[string]db.MessageDeliveryParams{
		"unknown id":          postParams(f.user, f.forum, "u1", "x", 9999),
		"duplicate id":        postParams(f.user, f.forum, "u2", "x", f.tag, f.tag),
		"tag of another":      postParams(f.user, f.forum, "u3", "x", otherTags[0].ID),
		"channel not a forum": postParams(f.user, f.text, "u4", "x"),
	}
	for name, p := range cases {
		_, err := f.db.CreateMessageDelivery(ctx, p)
		want := db.ErrForumTagUnknown
		if name == "channel not a forum" {
			want = db.ErrForumGone
		}
		if !errors.Is(err, want) {
			t.Fatalf("%s: err = %v, want %v", name, err, want)
		}
		if t1, m1, l1, r1 := postCounts(t, f.db); t1 != t0 || m1 != m0 || l1 != l0 || r1 != r0 {
			t.Fatalf("%s: wrote something: threads %d msgs %d links %d receipts %d", name, t1, m1, l1, r1)
		}
	}
	// An attachment-only post whose uploads all fail to link rolls the thread back too.
	empty := postParams(f.user, f.forum, "u5", "")
	empty.AttachmentIDs = []string{"missing"}
	if _, err := f.db.CreateMessageDelivery(ctx, empty); !errors.Is(err, db.ErrMessageDeliveryEmpty) {
		t.Fatalf("empty post err = %v", err)
	}
	if t1, m1, _, r1 := postCounts(t, f.db); t1 != t0 || m1 != m0 || r1 != r0 {
		t.Fatalf("an empty post left rows: threads %d msgs %d receipts %d", t1, m1, r1)
	}
}

// TestForumPostTagDeleteRace is the second pre-flight edge case: a tag deleted
// while a post naming it is created. The writer serialises them, so either the
// link is written and the later delete cascades it away, or the create is
// refused with nothing written. Never a post without its opening message, and
// never a link to a missing tag.
func TestForumPostTagDeleteRace(t *testing.T) {
	ctx := context.Background()
	for round := 0; round < 25; round++ {
		f := newForumFixture(t)
		start := make(chan struct{})
		var wg sync.WaitGroup
		var createErr, deleteErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, createErr = f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, "race", "x", f.tag))
		}()
		go func() {
			defer wg.Done()
			<-start
			_, deleteErr = f.db.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 60})
		}()
		close(start)
		wg.Wait()
		if deleteErr != nil {
			t.Fatalf("round %d: delete: %v", round, deleteErr)
		}
		if createErr != nil && !errors.Is(createErr, db.ErrForumTagUnknown) {
			t.Fatalf("round %d: create: %v", round, createErr)
		}
		var orphanPosts, orphanLinks, posts int
		must := func(q string, dst *int) {
			if err := f.db.QueryRowContext(ctx, q).Scan(dst); err != nil {
				t.Fatal(err)
			}
		}
		// The fixture's own post has its message; count only the race's post.
		must(`SELECT COUNT(*) FROM channels c WHERE c.type = 'thread' AND c.parent_channel_id = `+itoa(f.forum)+` AND c.thread_post_message_id IS NULL`, &orphanPosts)
		must(`SELECT COUNT(*) FROM thread_tags tt WHERE NOT EXISTS (SELECT 1 FROM forum_tags ft WHERE ft.id = tt.tag_id)`, &orphanLinks)
		must(`SELECT COUNT(*) FROM channels WHERE type = 'thread' AND parent_channel_id = `+itoa(f.forum), &posts)
		if orphanPosts != 0 || orphanLinks != 0 {
			t.Fatalf("round %d: %d posts without an opening message, %d links to a missing tag", round, orphanPosts, orphanLinks)
		}
		if createErr != nil && posts != 1 {
			t.Fatalf("round %d: refused create left %d posts (the fixture's one expected)", round, posts)
		}
		if createErr == nil && posts != 2 {
			t.Fatalf("round %d: committed create left %d posts, want 2", round, posts)
		}
	}
}

// TestThreadPostBlock covers the post block on every read of a thread: the
// preview cut, a deleted opening message, a hard-deleted one, tags in tag
// order, and no block at all on a thread under a text channel.
func TestThreadPostBlock(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	long := strings.Repeat("é", db.ForumPostPreviewRunes+50)
	p, err := f.db.CreateMessageDelivery(ctx, postParams(f.user, f.forum, "blk", long, f.tag))
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.db.GetThread(ctx, p.Thread.ID)
	if err != nil || got == nil || got.Post == nil {
		t.Fatalf("GetThread = %+v, %v", got, err)
	}
	if n := len([]rune(got.Post.FirstMessage.Preview)); n != db.ForumPostPreviewRunes {
		t.Fatalf("preview runes = %d", n)
	}
	rows, err := f.db.ListThreads(ctx, f.forum, false, db.ThreadCursor{}, 10)
	if err != nil || len(rows) != 2 {
		t.Fatalf("ListThreads = %d rows, %v", len(rows), err)
	}
	for _, r := range rows {
		if r.Post == nil || r.Post.FirstMessage == nil {
			t.Fatalf("list row %d has no post block", r.ID)
		}
	}
	// Soft delete keeps the pointer and reports deleted with no preview.
	if _, err := f.db.ExecContext(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, p.Message.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = f.db.GetThread(ctx, p.Thread.ID)
	if fm := got.Post.FirstMessage; fm == nil || !fm.Deleted || fm.Preview != "" {
		t.Fatalf("deleted first message = %+v", fm)
	}
	// Retention removes the row: the pointer goes NULL, and first_message is null.
	if _, err := f.db.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, p.Message.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = f.db.GetThread(ctx, p.Thread.ID)
	if got.Post == nil || got.Post.FirstMessage != nil {
		t.Fatalf("hard-deleted post = %+v", got.Post)
	}
	// A thread under a text channel never carries a post block.
	tt, err := f.db.GetThread(ctx, f.textThrd)
	if err != nil || tt == nil || tt.Post != nil {
		t.Fatalf("text thread = %+v, %v", tt, err)
	}
}

// TestUpdateThreadTags replaces a post's tags inside UpdateThread's
// transaction, refuses a tag of another forum, and a locked post to a
// non-moderator.
func TestUpdateThreadTags(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	tags, err := f.db.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 60, Tags: []db.ForumTagWrite{{ID: f.tag, Name: "bug"}, {Name: "idea"}, {Name: "q"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := []int64{tags[2].ID, tags[1].ID}
	out, err := f.db.UpdateThread(ctx, f.post, db.ThreadPatch{TagIDs: &ids}, false)
	if err != nil || out.Post == nil || len(out.Post.TagIDs) != 2 || out.Post.TagIDs[0] != tags[1].ID {
		t.Fatalf("UpdateThread = %+v, %v (tag ids are in tag order)", out, err)
	}
	none := []int64{}
	if out, err = f.db.UpdateThread(ctx, f.post, db.ThreadPatch{TagIDs: &none}, false); err != nil || len(out.Post.TagIDs) != 0 {
		t.Fatalf("clear = %+v, %v", out, err)
	}
	bad := []int64{9999}
	if _, err = f.db.UpdateThread(ctx, f.post, db.ThreadPatch{TagIDs: &bad}, false); !errors.Is(err, db.ErrForumTagUnknown) {
		t.Fatalf("unknown tag err = %v", err)
	}
	if _, err = f.db.UpdateThread(ctx, f.textThrd, db.ThreadPatch{TagIDs: &none}, false); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("tags on a text thread err = %v", err)
	}
	lock := true
	if _, err = f.db.UpdateThread(ctx, f.post, db.ThreadPatch{Locked: &lock}, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.UpdateThread(ctx, f.post, db.ThreadPatch{TagIDs: &ids}, false); !errors.Is(err, db.ErrThreadLockedForActor) {
		t.Fatalf("locked err = %v", err)
	}
	if _, err = f.db.UpdateThread(ctx, f.post, db.ThreadPatch{TagIDs: &ids}, true); err != nil {
		t.Fatalf("moderator on a locked post: %v", err)
	}
}
