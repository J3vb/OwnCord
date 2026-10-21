package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// forumFixture is a forum with one tag and one post under it (a thread with an
// opening message), plus a text channel with a thread of its own, as migration
// 075 shapes them. The post's opening message pointer is set.
type forumFixture struct {
	db       *db.DB
	user     int64
	forum    int64
	tag      int64
	post     int64
	postMsg  int64
	text     int64
	textMsg  int64
	textThrd int64
}

func newForumFixture(t *testing.T) forumFixture {
	t.Helper()
	ctx := context.Background()
	d := openMigratedMemory(t)
	f := forumFixture{db: d}
	var err error
	if f.user, err = d.CreateUser(ctx, "forumer", "hash", 4); err != nil {
		t.Fatal(err)
	}
	if f.forum, err = d.CreateChannel(ctx, "ideas", "forum", "", "", 0); err != nil {
		t.Fatalf("create forum: %v", err)
	}
	tags, err := d.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 4320,
		Tags:                      []db.ForumTagWrite{{Name: "bug"}},
	})
	if err != nil || len(tags) != 1 {
		t.Fatalf("seed tag: %v, %v", tags, err)
	}
	f.tag = tags[0].ID
	f.post = f.insertPost(t, f.forum)
	if f.postMsg, err = d.CreateMessage(ctx, f.post, f.user, "opening message", nil); err != nil {
		t.Fatalf("message in post: %v", err)
	}
	f.must(t, `UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, f.postMsg, f.post)
	if f.text, err = d.CreateChannel(ctx, "general", "text", "", "", 1); err != nil {
		t.Fatal(err)
	}
	if f.textMsg, err = d.CreateMessage(ctx, f.text, f.user, "start here", nil); err != nil {
		t.Fatal(err)
	}
	res, err := d.ExecContext(ctx,
		`INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id, thread_owner_id)
		 VALUES ('a thread', 'thread', ?, ?, ?)`, f.text, f.textMsg, f.user)
	if err != nil {
		t.Fatalf("thread under text: %v", err)
	}
	f.textThrd, _ = res.LastInsertId()
	return f
}

func (f forumFixture) insertPost(t *testing.T, forum int64) int64 {
	t.Helper()
	res, err := f.db.ExecContext(context.Background(),
		`INSERT INTO channels (name, type, parent_channel_id, thread_owner_id) VALUES ('a post', 'thread', ?, ?)`,
		forum, f.user)
	if err != nil {
		t.Fatalf("insert post: %v", err)
	}
	id, _ := res.LastInsertId()
	return id
}

func (f forumFixture) exec(t *testing.T, q string, args ...any) error {
	t.Helper()
	_, err := f.db.ExecContext(context.Background(), q, args...)
	return err
}

func (f forumFixture) count(t *testing.T, q string, args ...any) int {
	t.Helper()
	var n int
	if err := f.db.QueryRowContext(context.Background(), q, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

// TestForumShapeTriggers proves the schema refuses every forum or post row
// that breaks the forum model, and still allows the writes the model needs.
// 6.9c-a1's TestThreadRowShapeTrigger table runs unchanged beside it.
func TestForumShapeTriggers(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	voice, err := f.db.CreateChannel(ctx, "voice", "voice", "", "", 2)
	if err != nil {
		t.Fatal(err)
	}
	otherForum, err := f.db.CreateChannel(ctx, "other-forum", "forum", "", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	otherPost := f.insertPost(t, otherForum)
	otherMsg, err := f.db.CreateMessage(ctx, otherPost, f.user, "someone else's post", nil)
	if err != nil {
		t.Fatal(err)
	}
	postTwo := f.insertPost(t, f.forum)
	postTwoMsg, err := f.db.CreateMessage(ctx, postTwo, f.user, "second post", nil)
	if err != nil {
		t.Fatal(err)
	}
	threadMsg, err := f.db.CreateMessage(ctx, f.textThrd, f.user, "reply in a text thread", nil)
	if err != nil {
		t.Fatal(err)
	}

	refusedInserts := map[string]struct {
		q    string
		args []any
	}{
		"post with a starter":              {`INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id) VALUES ('x', 'thread', ?, ?)`, []any{f.forum, f.textMsg}},
		"post born with an opening msg":    {`INSERT INTO channels (name, type, parent_channel_id, thread_post_message_id) VALUES ('x', 'thread', ?, ?)`, []any{f.forum, f.postMsg}},
		"thread under a voice channel":     {`INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', ?)`, []any{voice}},
		"thread under a post":              {`INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', ?)`, []any{f.post}},
		"post with own nsfw":               {`INSERT INTO channels (name, type, parent_channel_id, nsfw) VALUES ('x', 'thread', ?, 1)`, []any{f.forum}},
		"post with own slow mode":          {`INSERT INTO channels (name, type, parent_channel_id, slow_mode) VALUES ('x', 'thread', ?, 5)`, []any{f.forum}},
		"forum with a parent":              {`INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'forum', ?)`, []any{f.forum}},
		"forum with thread columns":        {`INSERT INTO channels (name, type, thread_locked) VALUES ('x', 'forum', ?)`, []any{1}},
		"forum with an opening message":    {`INSERT INTO channels (name, type, thread_post_message_id) VALUES ('x', 'forum', ?)`, []any{f.postMsg}},
		"require_tag on a text channel":    {`INSERT INTO channels (name, type, forum_require_tag) VALUES ('x', 'text', ?)`, []any{1}},
		"archive period on a text channel": {`INSERT INTO channels (name, type, forum_default_auto_archive_minutes) VALUES ('x', 'text', ?)`, []any{60}},
		"require_tag on a post":            {`INSERT INTO channels (name, type, parent_channel_id, forum_require_tag) VALUES ('x', 'thread', ?, 1)`, []any{f.forum}},
		"archive period outside the set":   {`INSERT INTO channels (name, type, forum_default_auto_archive_minutes) VALUES ('x', 'forum', ?)`, []any{5}},
		"require_tag outside 0 and 1":      {`INSERT INTO channels (name, type, forum_require_tag) VALUES ('x', 'forum', ?)`, []any{2}},
	}
	for name, c := range refusedInserts {
		err := f.exec(t, c.q, c.args...)
		if err == nil {
			t.Errorf("%s: insert accepted, want the trigger to refuse it", name)
			continue
		}
		wantShapeRefusal(t, name, err)
	}

	refusedUpdates := map[string]struct {
		q    string
		args []any
	}{
		"opening message from another post":      {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{otherMsg, postTwo}},
		"opening message from this forum's text": {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{f.textMsg, postTwo}},
		"opening message from a sibling post":    {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{f.postMsg, postTwo}},
		"opening message changed once set":       {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{postTwoMsg, f.post}},
		"opening message on a text thread":       {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{threadMsg, f.textThrd}},
		"opening message on a text channel":      {`UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{f.textMsg, f.text}},
		"text channel becomes a forum":           {`UPDATE channels SET type = 'forum' WHERE id = ?`, []any{f.text}},
		"empty forum becomes text":               {`UPDATE channels SET type = 'text' WHERE id = ?`, []any{otherForum + 0}},
		"forum becomes a thread":                 {`UPDATE channels SET type = 'thread' WHERE id = ?`, []any{f.forum}},
		"post becomes a forum":                   {`UPDATE channels SET type = 'forum' WHERE id = ?`, []any{f.post}},
		"post moves to another forum":            {`UPDATE channels SET parent_channel_id = ? WHERE id = ?`, []any{otherForum, f.post}},
		"post gains a starter":                   {`UPDATE channels SET thread_starter_message_id = ? WHERE id = ?`, []any{f.textMsg, f.post}},
		"post gains its own nsfw":                {`UPDATE channels SET nsfw = 1 WHERE id = ?`, []any{f.post}},
		"require_tag on a text channel":          {`UPDATE channels SET forum_require_tag = 1 WHERE id = ?`, []any{f.text}},
		"archive period on a text channel":       {`UPDATE channels SET forum_default_auto_archive_minutes = 60 WHERE id = ?`, []any{f.text}},
		"require_tag on a post":                  {`UPDATE channels SET forum_require_tag = 1 WHERE id = ?`, []any{f.post}},
		"archive period outside the set":         {`UPDATE channels SET forum_default_auto_archive_minutes = 7 WHERE id = ?`, []any{f.forum}},
	}
	// "empty forum becomes text" needs a forum with no posts: otherForum has one.
	if err := f.exec(t, `DELETE FROM channels WHERE id = ?`, otherPost); err != nil {
		t.Fatal(err)
	}
	for name, c := range refusedUpdates {
		err := f.exec(t, c.q, c.args...)
		if err == nil {
			t.Errorf("%s: update accepted, want the trigger to refuse it", name)
			continue
		}
		wantShapeRefusal(t, name, err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM channels WHERE id = ? AND type = 'forum'`, otherForum); got != 1 {
		t.Errorf("the empty forum changed type")
	}

	allowed := []struct {
		name string
		q    string
		args []any
	}{
		{"opening message set once", `UPDATE channels SET thread_post_message_id = ? WHERE id = ?`, []any{postTwoMsg, postTwo}},
		{"opening message cleared", `UPDATE channels SET thread_post_message_id = NULL WHERE id = ?`, []any{postTwo}},
		{"forum settings", `UPDATE channels SET forum_require_tag = 1, forum_default_auto_archive_minutes = 60, topic = 'rules' WHERE id = ?`, []any{f.forum}},
		{"forum flags with posts", `UPDATE channels SET nsfw = 1, archived = 1, slow_mode = 9 WHERE id = ?`, []any{f.forum}},
		{"post own state", `UPDATE channels SET name = 'renamed', thread_locked = 1, thread_archived = 1, thread_last_activity_at = datetime('now') WHERE id = ?`, []any{f.post}},
		{"post auto archive period", `UPDATE channels SET thread_auto_archive_minutes = 10080 WHERE id = ?`, []any{f.post}},
	}
	for _, c := range allowed {
		if err := f.exec(t, c.q, c.args...); err != nil {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// Deleting the opening message (retention) nulls the pointer and the post stays.
	if err := f.exec(t, `DELETE FROM messages WHERE id = ?`, f.postMsg); err != nil {
		t.Fatalf("hard delete of the opening message: %v", err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM channels WHERE id = ? AND thread_post_message_id IS NULL`, f.post); got != 1 {
		t.Error("the post did not survive its opening message's hard delete with a NULL pointer")
	}
}

// wantShapeRefusal fails unless err is the shape trigger's refusal or a CHECK
// constraint, so a case cannot pass by tripping some unrelated constraint.
func wantShapeRefusal(t *testing.T, name string, err error) {
	t.Helper()
	msg := err.Error()
	if !strings.Contains(msg, "invalid thread or forum row") && !strings.Contains(msg, "CHECK constraint failed") {
		t.Errorf("%s: refused for the wrong reason: %v", name, err)
	}
}

// must runs a write the test needs to succeed.
func (f forumFixture) must(t *testing.T, q string, args ...any) {
	t.Helper()
	if err := f.exec(t, q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

// TestMessageInForumRefused proves the schema makes a message in a forum row
// impossible, on insert and on a move.
func TestMessageInForumRefused(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	refusal := func(what string, err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "a forum holds no messages") {
			t.Errorf("%s: err = %v, want the forum trigger's refusal", what, err)
		}
	}
	_, err := f.db.CreateMessage(ctx, f.forum, f.user, "into the forum", nil)
	refusal("CreateMessage into a forum", err)
	refusal("raw insert", f.exec(t, `INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'raw')`, f.forum, f.user))
	refusal("move into a forum", f.exec(t, `UPDATE messages SET channel_id = ? WHERE id = ?`, f.forum, f.textMsg))
	if _, err := f.db.CreateMessage(ctx, f.post, f.user, "reply in the post", nil); err != nil {
		t.Errorf("a reply in a post was refused: %v", err)
	}
	if got := f.count(t, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, f.forum); got != 0 {
		t.Errorf("%d messages in the forum row, want none", got)
	}
}

// TestThreadTagMustMatchForum proves a tag links only to a post of its own
// forum, and never moves between forums.
func TestThreadTagMustMatchForum(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	otherForum, err := f.db.CreateChannel(ctx, "other-forum", "forum", "", "", 3)
	if err != nil {
		t.Fatal(err)
	}
	otherPost := f.insertPost(t, otherForum)

	if err := f.exec(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, f.post, f.tag); err != nil {
		t.Fatalf("matching link: %v", err)
	}
	refused := map[string][]any{
		"tag of another forum on a post": {otherPost, f.tag},
		"tag on a text thread":           {f.textThrd, f.tag},
		"tag on the forum row":           {f.forum, f.tag},
		"tag on a text channel":          {f.text, f.tag},
		"tag that does not exist":        {f.post, f.tag + 100},
	}
	for name, args := range refused {
		if err := f.exec(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, args...); err == nil || !strings.Contains(err.Error(), "invalid thread tag") {
			t.Errorf("%s: err = %v, want the tag trigger's refusal", name, err)
		}
	}
	post2 := f.insertPost(t, f.forum)
	if err := f.exec(t, `UPDATE thread_tags SET thread_id = ? WHERE thread_id = ?`, otherPost, f.post); err == nil {
		t.Error("re-pointing a link at another forum's post succeeded")
	}
	if err := f.exec(t, `UPDATE thread_tags SET thread_id = ? WHERE thread_id = ?`, post2, f.post); err != nil {
		t.Errorf("re-pointing a link at a sibling post: %v", err)
	}

	// forum_tags: the forum must be a forum, and a tag never moves.
	if err := f.exec(t, `INSERT INTO forum_tags (forum_id, name) VALUES (?, 'x')`, f.text); err == nil {
		t.Error("tag on a text channel accepted")
	}
	if err := f.exec(t, `INSERT INTO forum_tags (forum_id, name) VALUES (?, 'x')`, f.post); err == nil {
		t.Error("tag on a post accepted")
	}
	if err := f.exec(t, `UPDATE forum_tags SET forum_id = ? WHERE id = ?`, otherForum, f.tag); err == nil {
		t.Error("a tag moved to another forum")
	}
	if err := f.exec(t, `INSERT INTO forum_tags (forum_id, name) VALUES (?, 'BUG')`, f.forum); err == nil {
		t.Error("a tag name differing only by case was accepted")
	}
}

// TestForumDeleteCascades proves deleting a forum removes its posts, their
// messages, its tags and the links, and nothing outside it.
func TestForumDeleteCascades(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	f.must(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, f.post, f.tag)
	if err := f.db.DeleteChannel(ctx, f.forum); err != nil {
		t.Fatalf("DeleteChannel(forum): %v", err)
	}
	for name, q := range map[string]string{
		"the forum":           `SELECT COUNT(*) FROM channels WHERE id = ?`,
		"its posts":           `SELECT COUNT(*) FROM channels WHERE parent_channel_id = ?`,
		"the posts' messages": `SELECT COUNT(*) FROM messages WHERE channel_id = ?`,
		"its tags":            `SELECT COUNT(*) FROM forum_tags WHERE forum_id = ?`,
	} {
		id := f.forum
		if name == "the posts' messages" {
			id = f.post
		}
		if n := f.count(t, q, id); n != 0 {
			t.Errorf("%s survived the forum's deletion (%d rows)", name, n)
		}
	}
	if n := f.count(t, `SELECT COUNT(*) FROM thread_tags`); n != 0 {
		t.Errorf("%d tag links survived", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM channels WHERE id IN (?, ?)`, f.text, f.textThrd); n != 2 {
		t.Error("the text channel or its thread was deleted with the forum")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ?`, f.textMsg); n != 1 {
		t.Error("a message outside the forum was deleted")
	}
}

// TestTagDeleteCascadesLinksOnly proves deleting a tag removes its links and
// leaves the post, its messages and its other tags alone.
func TestTagDeleteCascadesLinksOnly(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	tags, err := f.db.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 4320,
		Tags:                      []db.ForumTagWrite{{ID: f.tag, Name: "bug"}, {Name: "idea"}},
	})
	if err != nil || len(tags) != 2 {
		t.Fatalf("add a second tag: %v, %v", tags, err)
	}
	idea := tags[1].ID
	f.must(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?), (?, ?)`, f.post, f.tag, f.post, idea)
	if err := f.exec(t, `DELETE FROM forum_tags WHERE id = ?`, f.tag); err != nil {
		t.Fatal(err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM thread_tags WHERE tag_id = ?`, f.tag); n != 0 {
		t.Error("the deleted tag's link survived")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM thread_tags WHERE tag_id = ? AND thread_id = ?`, idea, f.post); n != 1 {
		t.Error("another tag's link was deleted")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM channels WHERE id = ? AND thread_post_message_id = ?`, f.post, f.postMsg); n != 1 {
		t.Error("the post or its opening message pointer changed")
	}
	if n := f.count(t, `SELECT COUNT(*) FROM messages WHERE id = ?`, f.postMsg); n != 1 {
		t.Error("the opening message was deleted")
	}
}

// TestListChannelsCarriesForumSettings proves the channel reads return a
// forum's settings and tags in order, and nothing on any other channel.
func TestListChannelsCarriesForumSettings(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	if _, err := f.db.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{
		RequireTag:                true,
		DefaultAutoArchiveMinutes: 1440,
		Tags:                      []db.ForumTagWrite{{Name: "zeta", Emoji: "🔥"}, {ID: f.tag, Name: "bug"}},
	}); err != nil {
		t.Fatal(err)
	}
	all, err := f.db.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var forum *db.Channel
	for i := range all {
		switch all[i].ID {
		case f.forum:
			forum = &all[i]
		case f.text:
			if all[i].Forum != nil {
				t.Error("a text channel carries forum settings")
			}
		case f.post:
			t.Error("ListChannels returned a post")
		}
	}
	if forum == nil || forum.Forum == nil {
		t.Fatalf("forum missing or without settings: %+v", forum)
	}
	got := forum.Forum
	if !got.RequireTag || got.DefaultAutoArchiveMinutes != 1440 || len(got.Tags) != 2 ||
		got.Tags[0].Name != "zeta" || got.Tags[0].Emoji != "🔥" || got.Tags[0].Position != 0 ||
		got.Tags[1].ID != f.tag || got.Tags[1].Position != 1 || got.Tags[1].Emoji != "" {
		t.Errorf("forum settings = %+v", got)
	}
	one, err := f.db.GetChannel(ctx, f.forum)
	if err != nil || one == nil || one.Forum == nil || len(one.Forum.Tags) != 2 {
		t.Fatalf("GetChannel(forum) = %+v, %v", one, err)
	}
	empty, err := f.db.CreateChannel(ctx, "empty", "forum", "", "", 5)
	if err != nil {
		t.Fatal(err)
	}
	e, _ := f.db.GetChannel(ctx, empty)
	if e == nil || e.Forum == nil || e.Forum.Tags == nil || len(e.Forum.Tags) != 0 || e.Forum.DefaultAutoArchiveMinutes != 4320 {
		t.Errorf("fresh forum = %+v, want defaults and an empty non-nil tag list", e)
	}
	if p, _ := f.db.GetChannel(ctx, f.post); p == nil || p.Forum != nil {
		t.Errorf("a post carries forum settings: %+v", p)
	}
}

// TestReplaceForumSettings proves the full-replace semantics: create, rename,
// reorder, swap names, delete by omission, and every refusal leaving the
// stored tags as they were.
func TestReplaceForumSettings(t *testing.T) {
	f := newForumFixture(t)
	ctx := context.Background()
	tagsOf := func() []db.ForumTag {
		c, err := f.db.GetChannel(ctx, f.forum)
		if err != nil || c == nil || c.Forum == nil {
			t.Fatalf("GetChannel: %v", err)
		}
		return c.Forum.Tags
	}
	write := func(tags ...db.ForumTagWrite) ([]db.ForumTag, error) {
		return f.db.ReplaceForumSettings(ctx, f.forum, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 4320, Tags: tags})
	}

	out, err := write(db.ForumTagWrite{ID: f.tag, Name: "bug"}, db.ForumTagWrite{Name: "idea"})
	if err != nil || len(out) != 2 {
		t.Fatalf("add: %v, %v", out, err)
	}
	idea := out[1].ID
	// Swap the two names in one write: the unique index must not trip.
	out, err = write(db.ForumTagWrite{ID: idea, Name: "bug"}, db.ForumTagWrite{ID: f.tag, Name: "idea", Emoji: "💡"})
	if err != nil || len(out) != 2 || out[0].ID != idea || out[0].Name != "bug" || out[1].ID != f.tag || out[1].Name != "idea" || out[1].Emoji != "💡" {
		t.Fatalf("swap: %+v, %v", out, err)
	}
	f.must(t, `INSERT INTO thread_tags (thread_id, tag_id) VALUES (?, ?)`, f.post, f.tag)
	before := tagsOf()

	// Refusals leave everything as it was, including the settings columns.
	if _, err := write(db.ForumTagWrite{Name: "a"}, db.ForumTagWrite{Name: "A"}); err == nil {
		t.Error("two names differing only by case were accepted")
	}
	if _, err := write(db.ForumTagWrite{ID: 9999, Name: "ghost"}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("unknown tag id: err = %v, want ErrNotFound", err)
	}
	other, err := f.db.CreateChannel(ctx, "other", "forum", "", "", 7)
	if err != nil {
		t.Fatal(err)
	}
	foreign, err := f.db.ReplaceForumSettings(ctx, other, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 4320, Tags: []db.ForumTagWrite{{Name: "theirs"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := write(db.ForumTagWrite{ID: foreign[0].ID, Name: "stolen"}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("another forum's tag id: err = %v, want ErrNotFound", err)
	}
	if _, err := write(db.ForumTagWrite{ID: f.tag, Name: "x"}, db.ForumTagWrite{ID: f.tag, Name: "y"}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("a repeated id: err = %v, want ErrNotFound", err)
	}
	many := make([]db.ForumTagWrite, db.MaxForumTags+1)
	for i := range many {
		many[i] = db.ForumTagWrite{Name: string(rune('a' + i))}
	}
	if _, err := write(many...); !errors.Is(err, db.ErrConflict) {
		t.Errorf("over the cap: err = %v, want ErrConflict", err)
	}
	if _, err := f.db.ReplaceForumSettings(ctx, f.text, db.ForumSettingsWrite{DefaultAutoArchiveMinutes: 4320}); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("a text channel: err = %v, want ErrNotFound", err)
	}
	after := tagsOf()
	if len(after) != len(before) {
		t.Fatalf("a refused write changed the tags: %+v -> %+v", before, after)
	}
	for i := range before {
		if before[i] != after[i] {
			t.Errorf("tag %d changed under a refused write: %+v -> %+v", i, before[i], after[i])
		}
	}

	// A cap-sized list is accepted, and omitting a tag deletes it and its links.
	exact := make([]db.ForumTagWrite, db.MaxForumTags)
	for i := range exact {
		exact[i] = db.ForumTagWrite{Name: string(rune('a' + i))}
	}
	if out, err = write(exact...); err != nil || len(out) != db.MaxForumTags {
		t.Fatalf("exactly the cap: %d tags, %v", len(out), err)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM thread_tags`); n != 0 {
		t.Errorf("omitted tags kept %d links", n)
	}
	if n := f.count(t, `SELECT COUNT(*) FROM channels WHERE id = ? AND thread_post_message_id = ?`, f.post, f.postMsg); n != 1 {
		t.Error("deleting tags changed the post")
	}
}
