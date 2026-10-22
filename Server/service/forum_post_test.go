package service

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const frmForum = 40

type forumPostFixture struct {
	*threadFixture
	limited *MessageService // shares one limiter with threads
	tags    []db.ForumTag
}

// newForumPostFixture is the thread fixture plus a forum (id 40) with three
// tags and a 60 minute default archive period. Members cannot attach files.
func newForumPostFixture(t *testing.T) *forumPostFixture {
	t.Helper()
	f := &forumPostFixture{threadFixture: newThreadFixture(t)}
	seedChannel(t, f.database, &db.Channel{ID: frmForum, Name: "ideas", Type: "forum"})
	tags, err := f.database.ReplaceForumSettings(bg(), frmForum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 60,
		Tags:                      []db.ForumTagWrite{{Name: "bug"}, {Name: "idea"}, {Name: "q"}, {Name: "d"}, {Name: "e"}, {Name: "f"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.tags = tags
	limiter := auth.NewRateLimiter()
	f.limited = NewMessageService(f.database, f.perms, limiter)
	f.threads = NewThreadService(f.database, f.perms, limiter)
	f.msgs.RunBackgroundInlineForTest()
	return f
}

func (f *forumPostFixture) req(user int64, name, content string, tagIdx ...int) ForumPostParams {
	p := ForumPostParams{
		ClientMessageID: newClientMessageID(), ChannelID: frmForum, UserID: user, Username: seedUsername(user),
		Name: name, Content: content,
	}
	for _, i := range tagIdx {
		p.TagIDs = append(p.TagIDs, f.tags[i].ID)
	}
	return p
}

func (f *forumPostFixture) counts(t *testing.T) (threads, msgs, receipts int) {
	t.Helper()
	for q, dst := range map[string]*int{
		`SELECT COUNT(*) FROM channels WHERE type = 'thread'`: &threads,
		`SELECT COUNT(*) FROM messages`:                       &msgs,
		`SELECT COUNT(*) FROM message_delivery_receipts`:      &receipts,
	} {
		if err := f.database.QueryRowContext(bg(), q).Scan(dst); err != nil {
			t.Fatal(err)
		}
	}
	return threads, msgs, receipts
}

func TestCreateForumPost_Happy(t *testing.T) {
	f := newForumPostFixture(t)
	res, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "  Dark mode  ", "please <b>add</b> it", 1, 0))
	if err != nil {
		t.Fatalf("CreateForumPost: %v", err)
	}
	th := res.Thread
	if res.Duplicate || th.Name != "Dark mode" || th.ParentID != frmForum || th.StarterMessageID != nil ||
		th.OwnerID == nil || *th.OwnerID != thrOwner || th.AutoArchiveMinutes != 60 {
		t.Fatalf("thread = %+v", th)
	}
	if th.Post == nil || th.Post.FirstMessage == nil || th.Post.FirstMessage.ID != res.MessageID ||
		th.Post.FirstMessage.Preview != "please add it" || len(th.Post.TagIDs) != 2 {
		t.Fatalf("post = %+v", th.Post)
	}
	if th.Post.TagIDs[0] != f.tags[0].ID {
		t.Fatalf("tag ids = %v, want tag order", th.Post.TagIDs)
	}
	if res.Send == nil || res.Send.Channel == nil || res.Send.Channel.ID != th.ID || !res.Send.Channel.IsThread() ||
		res.Send.Content != "please add it" {
		t.Fatalf("send = %+v", res.Send)
	}
	if got, err := f.database.GetMessage(bg(), res.MessageID); err != nil || got == nil || got.ChannelID != th.ID {
		t.Fatalf("opening message = %+v, %v", got, err)
	}
	if _, _, found, err := f.database.GetReadState(bg(), thrOwner, th.ID); err != nil || !found {
		t.Fatalf("author read state on the post: found=%v err=%v", found, err)
	}
	// The forum itself still holds no message.
	if n, _ := f.database.GetLatestMessageID(bg(), frmForum); n != 0 {
		t.Fatalf("forum holds message %d", n)
	}
}

func TestCreateForumPost_RefusalsWriteNothing(t *testing.T) {
	f := newForumPostFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 41, Name: "text", Type: "text"})
	tooMany := make([]int, 0, 6)
	for i := range 6 {
		tooMany = append(tooMany, i)
	}
	cases := []struct {
		name string
		mod  func(p *ForumPostParams)
		want error
	}{
		{"empty title", func(p *ForumPostParams) { p.Name = " \t" }, ErrBadRequest},
		{"long title", func(p *ForumPostParams) { p.Name = strings.Repeat("x", 101) }, ErrBadRequest},
		{"empty content", func(p *ForumPostParams) { p.Content = "<b></b>" }, ErrBadRequest},
		{"long content", func(p *ForumPostParams) { p.Content = strings.Repeat("x", 4001) }, ErrBadRequest},
		{"six tags", func(p *ForumPostParams) { *p = f.req(thrOwner, "t", "c", tooMany...) }, ErrBadRequest},
		{"duplicate tag", func(p *ForumPostParams) { p.TagIDs = []int64{f.tags[0].ID, f.tags[0].ID} }, ErrBadRequest},
		{"unknown tag", func(p *ForumPostParams) { p.TagIDs = []int64{9999} }, ErrBadRequest},
		{"zero tag", func(p *ForumPostParams) { p.TagIDs = []int64{0} }, ErrBadRequest},
		{"upload without ATTACH_FILES", func(p *ForumPostParams) { p.AttachmentIDs = []string{"a"} }, ErrForbidden},
		{"text channel", func(p *ForumPostParams) { p.ChannelID = 41 }, ErrBadRequest},
		{"no channel", func(p *ForumPostParams) { p.ChannelID = 9999 }, ErrNotFound},
		{"no client id", func(p *ForumPostParams) { p.ClientMessageID = "" }, ErrBadRequest},
		{"bad client id", func(p *ForumPostParams) { p.ClientMessageID = "nope" }, ErrBadRequest},
	}
	// A fresh limiter per case keeps the create budget out of it.
	for _, c := range cases {
		svc := NewMessageService(f.database, f.perms, auth.NewRateLimiter())
		p := f.req(thrOwner, "title", "content")
		c.mod(&p)
		t0, m0, r0 := f.counts(t)
		if _, err := svc.CreateForumPost(bg(), p); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
		if t1, m1, r1 := f.counts(t); t1 != t0 || m1 != m0 || r1 != r0 {
			t.Errorf("%s wrote something: threads %d->%d msgs %d->%d receipts %d->%d", c.name, t0, t1, m0, m1, r0, r1)
		}
	}
}

func TestCreateForumPost_SendGate(t *testing.T) {
	f := newForumPostFixture(t)
	seedChannelOverride(t, f.database, permissions.MemberRoleID, frmForum, 0, permissions.SendMessages)
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "t", "c")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("member with SEND denied: err = %v", err)
	}
	if _, err := f.database.ExecContext(bg(), `UPDATE channels SET archived = 1 WHERE id = ?`, frmForum); err != nil {
		t.Fatal(err)
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrMod, "t", "c")); !errors.Is(err, ErrForbidden) {
		t.Fatalf("archived forum: err = %v", err)
	}
	if n, _, _ := f.counts(t); n != 0 {
		t.Fatalf("%d threads written", n)
	}
}

func TestCreateForumPost_RequireTag(t *testing.T) {
	f := newForumPostFixture(t)
	if _, err := f.database.ReplaceForumSettings(bg(), frmForum, db.ForumSettingsWrite{
		RequireTag: true, DefaultAutoArchiveMinutes: 4320, Tags: []db.ForumTagWrite{{ID: f.tags[0].ID, Name: "bug"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "t", "c")); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("no tag in a require-tag forum: err = %v", err)
	}
	res, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "t", "c", 0))
	if err != nil {
		t.Fatal(err)
	}
	if res.Thread.AutoArchiveMinutes != 4320 {
		t.Fatalf("archive minutes = %d, want the forum's 4320", res.Thread.AutoArchiveMinutes)
	}
}

// Pre-flight edge case 1: a lost forum_post_create_ok, retried.
func TestCreateForumPost_RetryIsIdempotent(t *testing.T) {
	f := newForumPostFixture(t)
	p := f.req(thrOwner, "once", "body", 0)
	first, err := f.limited.CreateForumPost(bg(), p)
	if err != nil {
		t.Fatal(err)
	}
	t0, m0, r0 := f.counts(t)
	again, err := f.limited.CreateForumPost(bg(), p)
	if err != nil || !again.Duplicate || again.Thread.ID != first.Thread.ID || again.MessageID != first.MessageID || again.Send != nil {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	if t1, m1, r1 := f.counts(t); t1 != t0 || m1 != m0 || r1 != r0 {
		t.Fatalf("the retry wrote: threads %d->%d msgs %d->%d receipts %d->%d", t0, t1, m0, m1, r0, r1)
	}
	// Tag order does not matter to the fingerprint.
	two := f.req(thrOwner, "two", "body", 1, 0)
	if _, err := f.limited.CreateForumPost(bg(), two); err != nil {
		t.Fatal(err)
	}
	two.TagIDs = []int64{f.tags[0].ID, f.tags[1].ID}
	if r, err := f.limited.CreateForumPost(bg(), two); err != nil || !r.Duplicate {
		t.Fatalf("reordered tags retry = %+v, %v", r, err)
	}
	// A changed payload under the same id conflicts, whatever field changed.
	for name, mod := range map[string]func(*ForumPostParams){
		"title":   func(q *ForumPostParams) { q.Name = "changed" },
		"content": func(q *ForumPostParams) { q.Content = "changed" },
		"tags":    func(q *ForumPostParams) { q.TagIDs = nil },
		"upload":  func(q *ForumPostParams) { q.AttachmentIDs = []string{"x"} },
	} {
		q := p
		mod(&q)
		if _, err := f.limited.CreateForumPost(bg(), q); !errors.Is(err, ErrConflict) {
			t.Errorf("changed %s: err = %v, want ErrConflict", name, err)
		}
	}
	// The retry is answered before the permission gates: a user who lost SEND
	// since still gets their acknowledgement.
	seedChannelOverride(t, f.database, permissions.MemberRoleID, frmForum, 0, permissions.SendMessages)
	if r, err := f.limited.CreateForumPost(bg(), p); err != nil || !r.Duplicate {
		t.Fatalf("retry after losing SEND = %+v, %v", r, err)
	}
}

func TestCreateForumPost_RetryAfterDelete(t *testing.T) {
	f := newForumPostFixture(t)
	p := f.req(thrOwner, "gone", "body")
	first, err := f.limited.CreateForumPost(bg(), p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.threads.Delete(bg(), thrMod, first.Thread.ID); err != nil {
		t.Fatalf("moderator delete: %v", err)
	}
	t0, _, _ := f.counts(t)
	if _, err := f.limited.CreateForumPost(bg(), p); !errors.Is(err, ErrDeletedMessage) {
		t.Fatalf("retry after the post was deleted: err = %v, want ErrDeletedMessage", err)
	}
	if t1, _, _ := f.counts(t); t1 != t0 {
		t.Fatal("the retry recreated the post")
	}
}

// A retry of a post that has since been archived is still a retry: it gets the
// same post back and nothing is written.
func TestCreateForumPost_RetryAfterArchive(t *testing.T) {
	f := newForumPostFixture(t)
	p := f.req(thrOwner, "quiet", "body")
	first, err := f.limited.CreateForumPost(bg(), p)
	if err != nil {
		t.Fatal(err)
	}
	archived := true
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: first.Thread.ID, Archived: &archived}); err != nil {
		t.Fatalf("archive: %v", err)
	}
	t0, m0, r0 := f.counts(t)
	again, err := f.limited.CreateForumPost(bg(), p)
	if err != nil || !again.Duplicate || again.MessageID != first.MessageID || again.Thread == nil || !again.Thread.Archived {
		t.Fatalf("retry after archive = %+v, %v", again, err)
	}
	if t1, m1, r1 := f.counts(t); t1 != t0 || m1 != m0 || r1 != r0 {
		t.Fatalf("the retry wrote: threads %d->%d msgs %d->%d receipts %d->%d", t0, t1, m0, m1, r0, r1)
	}
}

// A retry from a caller who has since lost the forum is acknowledged without
// the post's body.
func TestCreateForumPost_RetryAfterLosingView(t *testing.T) {
	f := newForumPostFixture(t)
	p := f.req(thrOwner, "hidden", "body")
	first, err := f.limited.CreateForumPost(bg(), p)
	if err != nil {
		t.Fatal(err)
	}
	seedChannelOverride(t, f.database, permissions.MemberRoleID, frmForum, 0, permissions.ReadMessages)
	f.perms.InvalidateAll()
	r, err := f.limited.CreateForumPost(bg(), p)
	if err != nil || !r.Duplicate || r.MessageID != first.MessageID || r.Thread != nil {
		t.Fatalf("retry after losing view = %+v, %v", r, err)
	}
}

// A malformed request never spends the shared create budget.
func TestCreateForumPost_ShapeErrorsCostNoToken(t *testing.T) {
	f := newForumPostFixture(t)
	for range 8 {
		if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, " ", "body")); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("empty title: err = %v, want ErrBadRequest", err)
		}
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "fine", "body")); err != nil {
		t.Fatalf("a valid post after bad ones: %v", err)
	}
}

func TestCreateForumPost_SlowModeAndBudget(t *testing.T) {
	f := newForumPostFixture(t)
	if _, err := f.database.ExecContext(bg(), `UPDATE channels SET slow_mode = 30 WHERE id = ?`, frmForum); err != nil {
		t.Fatal(err)
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "a", "b")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "a2", "b")); !errors.Is(err, ErrSlowMode) {
		t.Fatalf("second post inside slow mode: err = %v", err)
	}
	// A moderator is exempt from slow mode; posts and thread_create share one
	// budget of 5 per user.
	for i := range threadCreateLimit {
		if _, err := f.limited.CreateForumPost(bg(), f.req(thrMod, fmt.Sprintf("m%d", i), "b")); err != nil {
			t.Fatalf("mod post %d: %v", i, err)
		}
	}
	if _, err := f.limited.CreateForumPost(bg(), f.req(thrMod, "over", "b")); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("sixth post: err = %v, want ErrRateLimited", err)
	}
	starter := f.post(t, thrParent, thrMod, "s")
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrMod, ChannelID: thrParent, MessageID: starter, Name: "t"}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("thread_create after five posts: err = %v, want ErrRateLimited", err)
	}
}

func TestSendAndThreadCreateRefuseAForum(t *testing.T) {
	f := newForumPostFixture(t)
	if _, err := f.msgs.SendMessage(bg(), SendMessageParams{ChannelID: frmForum, UserID: thrOwner, Username: "u", Content: "x"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("chat_send into a forum: err = %v", err)
	}
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: frmForum, MessageID: 1, Name: "t"}); err == nil {
		t.Fatal("thread_create under a forum")
	}
}

func TestCreateForumPost_MentionsRaiseABadgeOnThePost(t *testing.T) {
	f := newForumPostFixture(t)
	res, err := f.msgs.CreateForumPost(bg(), f.req(thrOwner, "hey", "hello @bob"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Send.Mentions) != 1 || res.Send.Mentions[0] != thrOther {
		t.Fatalf("mentions = %v", res.Send.Mentions)
	}
	if _, mentions, found, err := f.database.GetReadState(bg(), thrOther, res.Thread.ID); err != nil || !found || mentions != 1 {
		t.Fatalf("bob's badge on the post: mentions=%d found=%v err=%v", mentions, found, err)
	}
}

func TestThreadUpdate_PostTags(t *testing.T) {
	f := newForumPostFixture(t)
	res, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "p", "c", 0))
	if err != nil {
		t.Fatal(err)
	}
	id := res.Thread.ID
	set := func(user int64, ids ...int64) (*db.ThreadInfo, error) {
		if ids == nil {
			ids = []int64{}
		}
		return f.threads.Update(bg(), UpdateThreadParams{UserID: user, ThreadID: id, TagIDs: &ids})
	}
	out, err := set(thrOwner, f.tags[2].ID, f.tags[1].ID)
	if err != nil || len(out.Post.TagIDs) != 2 || out.Post.TagIDs[0] != f.tags[1].ID {
		t.Fatalf("owner retag = %+v, %v", out, err)
	}
	if _, err := set(thrOther, f.tags[0].ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("stranger retag: err = %v", err)
	}
	if out, err = set(thrMod, f.tags[0].ID); err != nil || len(out.Post.TagIDs) != 1 {
		t.Fatalf("moderator retag = %+v, %v", out, err)
	}
	if out, err = set(thrOwner); err != nil || len(out.Post.TagIDs) != 0 {
		t.Fatalf("clear tags = %+v, %v", out, err)
	}
	for name, ids := range map[string][]int64{
		"unknown": {9999}, "duplicate": {f.tags[0].ID, f.tags[0].ID},
		"six": {f.tags[0].ID, f.tags[1].ID, f.tags[2].ID, f.tags[3].ID, f.tags[4].ID, f.tags[5].ID},
	} {
		if _, err := set(thrOwner, ids...); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
	// A locked post is the moderators'.
	lock := true
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: id, Locked: &lock}); err != nil {
		t.Fatal(err)
	}
	if _, err := set(thrOwner, f.tags[0].ID); !errors.Is(err, permissions.ErrThreadLocked) {
		t.Fatalf("owner retag of a locked post: err = %v", err)
	}
	if _, err := set(thrMod, f.tags[0].ID); err != nil {
		t.Fatalf("moderator retag of a locked post: %v", err)
	}
	// A forum that requires a tag refuses an edit that leaves none.
	if _, err := f.database.ReplaceForumSettings(bg(), frmForum, db.ForumSettingsWrite{
		RequireTag: true, DefaultAutoArchiveMinutes: 60, Tags: []db.ForumTagWrite{{ID: f.tags[0].ID, Name: "bug"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := set(thrMod); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("clearing the only tag in a require-tag forum: err = %v", err)
	}
	// Tags belong to forum posts only.
	text := f.start(t, thrOwner, "plain")
	ids := []int64{}
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: text.ID, TagIDs: &ids}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("tags on a text thread: err = %v", err)
	}
}

func TestEditOpeningMessageIsFlagged(t *testing.T) {
	f := newForumPostFixture(t)
	res, err := f.msgs.CreateForumPost(bg(), f.req(thrOwner, "p", "first"))
	if err != nil {
		t.Fatal(err)
	}
	reply := f.post(t, res.Thread.ID, thrOther, "a reply")
	edited, err := f.msgs.EditMessage(bg(), thrOwner, res.MessageID, "first, edited")
	if err != nil || !edited.PostOpening {
		t.Fatalf("edit of the opening message = %+v, %v", edited, err)
	}
	if got, _ := f.threads.Get(bg(), res.Thread.ID); got.Post.FirstMessage.Preview != "first, edited" {
		t.Fatalf("preview = %q", got.Post.FirstMessage.Preview)
	}
	if other, err := f.msgs.EditMessage(bg(), thrOther, reply, "reply, edited"); err != nil || other.PostOpening {
		t.Fatalf("edit of a reply = %+v, %v", other, err)
	}
	text := f.start(t, thrOwner, "t")
	msg := f.post(t, text.ID, thrOwner, "in a text thread")
	if r, err := f.msgs.EditMessage(bg(), thrOwner, msg, "again"); err != nil || r.PostOpening {
		t.Fatalf("edit in a text thread = %+v, %v", r, err)
	}
}

func TestDeletedOpeningMessageKeepsThePost(t *testing.T) {
	f := newForumPostFixture(t)
	res, err := f.msgs.CreateForumPost(bg(), f.req(thrOwner, "p", "first"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.msgs.DeleteMessage(bg(), thrOwner, res.MessageID); err != nil {
		t.Fatal(err)
	}
	got, _ := f.threads.Get(bg(), res.Thread.ID)
	if got == nil || got.Post == nil || got.Post.FirstMessage == nil || !got.Post.FirstMessage.Deleted || got.Post.FirstMessage.Preview != "" {
		t.Fatalf("post after the delete = %+v", got)
	}
}

func TestMarkReadOnAForumWritesNoReadState(t *testing.T) {
	f := newForumPostFixture(t)
	for name, op := range map[string]db.ReadPointerOp{"read at latest": db.ReadAtLatest, "read up to": db.ReadUpTo, "mark unread": db.MarkUnread} {
		if _, err := f.msgs.MoveReadPointer(bg(), thrOwner, frmForum, op, 1); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s on a forum: err = %v, want ErrNotFound", name, err)
		}
	}
	if _, _, found, err := f.database.GetReadState(bg(), thrOwner, frmForum); err != nil || found {
		t.Fatalf("a read_states row exists for the forum: found=%v err=%v", found, err)
	}
}
