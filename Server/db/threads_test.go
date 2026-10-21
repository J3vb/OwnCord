package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// threadFixture is a text parent with one message and a thread started from
// it, plus a user, as migration 074 shapes them.
type threadFixture struct {
	db      *db.DB
	user    int64
	parent  int64
	starter int64
	thread  int64
}

func newThreadFixture(t *testing.T) threadFixture {
	t.Helper()
	ctx := context.Background()
	d := openMigratedMemory(t)
	u, err := d.CreateUser(ctx, "threader", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := d.CreateMessage(ctx, parent, u, "start here", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := d.ExecContext(ctx,
		`INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id, thread_owner_id)
		 VALUES ('a thread', 'thread', ?, ?, ?)`, parent, starter, u)
	if err != nil {
		t.Fatalf("insert thread: %v", err)
	}
	thread, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return threadFixture{db: d, user: u, parent: parent, starter: starter, thread: thread}
}

func (f threadFixture) exec(t *testing.T, q string, args ...any) error {
	t.Helper()
	_, err := f.db.ExecContext(context.Background(), q, args...)
	return err
}

// TestThreadRowShapeTrigger proves the schema refuses every thread row that
// could carry permission state of its own, or move to another parent.
func TestThreadRowShapeTrigger(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	voice, err := f.db.CreateChannel(ctx, "voice", "voice", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	other, err := f.db.CreateChannel(ctx, "other", "text", "", "", 2)
	if err != nil {
		t.Fatal(err)
	}

	refusedInserts := map[string]string{
		"thread without parent":    `INSERT INTO channels (name, type) VALUES ('x', 'thread')`,
		"text with parent":         `INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'text', ?)`,
		"own nsfw":                 `INSERT INTO channels (name, type, parent_channel_id, nsfw) VALUES ('x', 'thread', ?, 1)`,
		"own archived":             `INSERT INTO channels (name, type, parent_channel_id, archived) VALUES ('x', 'thread', ?, 1)`,
		"own slow mode":            `INSERT INTO channels (name, type, parent_channel_id, slow_mode) VALUES ('x', 'thread', ?, 5)`,
		"own afk":                  `INSERT INTO channels (name, type, parent_channel_id, afk) VALUES ('x', 'thread', ?, 1)`,
		"bad auto archive":         `INSERT INTO channels (name, type, parent_channel_id, thread_auto_archive_minutes) VALUES ('x', 'thread', ?, 5)`,
		"thread columns on text":   `INSERT INTO channels (name, type, thread_locked) VALUES ('x', 'text', ?)`,
		"category on thread":       `INSERT INTO channels (name, type, parent_channel_id, category_id) VALUES ('x', 'thread', ?, (SELECT MIN(id) FROM channels))`,
		"missing parent row":       `INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', ? + 1000)`,
		"duplicate starter":        `INSERT INTO channels (name, type, parent_channel_id, thread_starter_message_id) VALUES ('x', 'thread', ?, (SELECT thread_starter_message_id FROM channels WHERE type = 'thread'))`,
		"thread under thread":      `INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', (SELECT id FROM channels WHERE type = 'thread' AND ? > 0))`,
		"thread under voice":       `INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', ?)`,
		"thread under nonsense id": `INSERT INTO channels (name, type, parent_channel_id) VALUES ('x', 'thread', -?)`,
	}
	for name, q := range refusedInserts {
		arg := f.parent
		switch name {
		case "thread columns on text":
			arg = 1
		case "thread under voice":
			arg = voice
		}
		err := f.exec(t, q, arg)
		if err == nil {
			t.Errorf("%s: insert accepted, want the trigger to refuse it", name)
		}
	}

	refusedUpdates := map[string]string{
		"move to another parent": `UPDATE channels SET parent_channel_id = ? WHERE id = ?`,
		"clear the parent":       `UPDATE channels SET parent_channel_id = NULL WHERE id = ? AND ? > 0`,
		"turn into text":         `UPDATE channels SET type = 'text' WHERE id = ? AND ? > 0`,
		"set own nsfw":           `UPDATE channels SET nsfw = 1 WHERE id = ? AND ? > 0`,
		"set own archived":       `UPDATE channels SET archived = 1 WHERE id = ? AND ? > 0`,
		"set own slow mode":      `UPDATE channels SET slow_mode = 3 WHERE id = ? AND ? > 0`,
	}
	for name, q := range refusedUpdates {
		first, second := f.thread, f.thread
		if name == "move to another parent" {
			first, second = other, f.thread
		}
		err := f.exec(t, q, first, second)
		if err == nil {
			t.Errorf("%s: update accepted, want the trigger to refuse it", name)
		}
	}
	if err := f.exec(t, `UPDATE channels SET type = 'voice' WHERE id = ?`, f.parent); err == nil {
		t.Error("a parent with threads changed type, want the trigger to refuse it")
	}
	if err := f.exec(t, `UPDATE channels SET type = 'thread', parent_channel_id = ? WHERE id = ?`, f.parent, other); err == nil {
		t.Error("a text channel became a thread, want the trigger to refuse it")
	}

	// The thread's own state and its display fields stay writable.
	allowed := []string{
		`UPDATE channels SET name = 'renamed', thread_locked = 1, thread_archived = 1 WHERE id = ?`,
		`UPDATE channels SET thread_auto_archive_minutes = 60, thread_last_activity_at = datetime('now') WHERE id = ?`,
		`UPDATE channels SET thread_starter_message_id = NULL WHERE id = ?`,
	}
	for _, q := range allowed {
		if err := f.exec(t, q, f.thread); err != nil {
			t.Errorf("%s: %v", q, err)
		}
	}
	// The parent's own flags stay writable while it has threads.
	if err := f.exec(t, `UPDATE channels SET nsfw = 1, archived = 1, slow_mode = 9 WHERE id = ?`, f.parent); err != nil {
		t.Errorf("parent flags: %v", err)
	}
}

// TestThreadInheritsParentChannelState proves a thread row reads its parent's
// NSFW, archive and slow mode, and that ListChannels stays parents-only.
func TestThreadInheritsParentChannelState(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	if err := f.exec(t, `UPDATE channels SET nsfw = 1, archived = 1, slow_mode = 7 WHERE id = ?`, f.parent); err != nil {
		t.Fatal(err)
	}
	if err := f.exec(t, `UPDATE channels SET thread_locked = 1 WHERE id = ?`, f.thread); err != nil {
		t.Fatal(err)
	}
	ch, err := f.db.GetChannel(ctx, f.thread)
	if err != nil || ch == nil {
		t.Fatalf("GetChannel(thread) = %v, %v", ch, err)
	}
	if !ch.NSFW || !ch.Archived || ch.SlowMode != 7 {
		t.Errorf("thread flags = nsfw %v archived %v slow %d, want the parent's true, true, 7", ch.NSFW, ch.Archived, ch.SlowMode)
	}
	if !ch.IsThread() || ch.AuthorityID() != f.parent || !ch.Thread.Locked || ch.Thread.Archived {
		t.Errorf("thread state = %+v, authority %d, want parent %d, locked, not archived", ch.Thread, ch.AuthorityID(), f.parent)
	}
	p, err := f.db.GetChannel(ctx, f.parent)
	if err != nil || p == nil {
		t.Fatal(err)
	}
	if p.IsThread() || p.AuthorityID() != f.parent {
		t.Errorf("parent reads as a thread: %+v", p.Thread)
	}
	all, err := f.db.ListChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for i := range all {
		if all[i].ID == f.thread {
			t.Fatal("ListChannels returned the thread, want parents only")
		}
	}
}

// TestThreadOverrideReadsResolveParent proves the single-channel override
// reads answer a thread id with the parent's rows, and that a thread never
// shows up in the per-member batch map (whose callers resolve first).
func TestThreadOverrideReadsResolveParent(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	const role = 4
	if err := f.db.UpsertChannelOverride(ctx, f.parent, role, 0x10, 0x20); err != nil {
		t.Fatal(err)
	}
	if err := f.db.UpsertChannelUserOverride(ctx, f.parent, f.user, 0x40, 0x80); err != nil {
		t.Fatal(err)
	}
	if allow, deny, err := f.db.GetChannelPermissions(ctx, f.thread, role); err != nil || allow != 0x10 || deny != 0x20 {
		t.Errorf("role override on thread = %#x/%#x, %v, want the parent's 0x10/0x20", allow, deny, err)
	}
	if allow, deny, err := f.db.GetUserChannelPermissions(ctx, f.thread, f.user); err != nil || allow != 0x40 || deny != 0x80 {
		t.Errorf("user override on thread = %#x/%#x, %v, want the parent's 0x40/0x80", allow, deny, err)
	}
	m, err := f.db.GetChannelOverridesFor(ctx, role, f.user)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m[f.thread]; ok {
		t.Error("the batch override map has a thread key, want parent keys only")
	}
	if o := m[f.parent]; o.Allow != 0x10 || o.UserDeny != 0x80 {
		t.Errorf("parent entry = %+v", o)
	}
}

// TestThreadNSFWConsentIsParents proves the acknowledgement reads take a
// thread id as its parent's, and the raw acknowledge refuses a thread id
// (its own label is always 0), so no row is ever keyed by a thread.
func TestThreadNSFWConsentIsParents(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	if err := f.exec(t, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.parent); err != nil {
		t.Fatal(err)
	}
	if labelled, err := f.db.AcknowledgeNSFW(ctx, f.user, f.thread); err != nil || labelled {
		t.Errorf("AcknowledgeNSFW(thread) = %v, %v, want not labelled", labelled, err)
	}
	if ok, err := f.db.HasNSFWAcknowledgement(ctx, f.user, f.thread); err != nil || ok {
		t.Fatalf("before the parent ack: %v, %v", ok, err)
	}
	if labelled, err := f.db.AcknowledgeNSFW(ctx, f.user, f.parent); err != nil || !labelled {
		t.Fatalf("AcknowledgeNSFW(parent) = %v, %v", labelled, err)
	}
	if ok, err := f.db.HasNSFWAcknowledgement(ctx, f.user, f.thread); err != nil || !ok {
		t.Errorf("HasNSFWAcknowledgement(thread) = %v, %v, want the parent's ack", ok, err)
	}
	ids, err := f.db.ListNSFWAcknowledgedUserIDs(ctx, f.thread)
	if err != nil || len(ids) != 1 || ids[0] != f.user {
		t.Errorf("ListNSFWAcknowledgedUserIDs(thread) = %v, %v", ids, err)
	}
	var keyed int
	if err := f.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM nsfw_acknowledgements WHERE channel_id = ?`, f.thread).Scan(&keyed); err != nil || keyed != 0 {
		t.Errorf("%d acknowledgement rows keyed by the thread, %v", keyed, err)
	}
}

// TestThreadAttachmentTakesParentNSFW proves the attachment read gate sees a
// thread attachment as labelled when the parent is.
func TestThreadAttachmentTakesParentNSFW(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	msg, err := f.db.CreateMessage(ctx, f.thread, f.user, "pic", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.db.CreateAttachment(ctx, "att-thread", f.user, "a.png", "a.png", "image/png", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.LinkAttachmentsToMessage(ctx, msg, f.user, []string{"att-thread"}); err != nil {
		t.Fatal(err)
	}
	a, err := f.db.GetAttachmentWithChannel(ctx, "att-thread")
	if err != nil || a == nil || a.ChannelNSFW {
		t.Fatalf("unlabelled parent: %+v, %v", a, err)
	}
	if err := f.exec(t, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.parent); err != nil {
		t.Fatal(err)
	}
	a, err = f.db.GetAttachmentWithChannel(ctx, "att-thread")
	if err != nil || a == nil || !a.ChannelNSFW || a.ChannelType != "thread" {
		t.Errorf("labelled parent: %+v, %v, want ChannelNSFW", a, err)
	}
}

// TestThreadRetentionFollowsParent proves a thread is swept under its
// parent's window and cannot get one of its own.
func TestThreadRetentionFollowsParent(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	if err := f.db.SetChannelRetention(ctx, f.parent, 30, f.user); err != nil {
		t.Fatal(err)
	}
	ws, err := f.db.RetentionWindows(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, w := range ws {
		if w.ChannelID == f.thread {
			found = true
			if w.Days != 30 || w.Source != "channel" {
				t.Errorf("thread window = %+v, want the parent's 30 days", w)
			}
		}
	}
	if !found {
		t.Error("the thread has no retention window, want its parent's")
	}
}

// TestThreadGoesWithParent proves the cascade: deleting the parent removes
// its threads, and deleting the starter message keeps the thread.
func TestThreadGoesWithParent(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	if err := f.exec(t, `DELETE FROM messages WHERE id = ?`, f.starter); err != nil {
		t.Fatal(err)
	}
	ch, err := f.db.GetChannel(ctx, f.thread)
	if err != nil || ch == nil {
		t.Fatalf("thread gone with its starter: %v", err)
	}
	if err := f.db.DeleteChannel(ctx, f.parent); err != nil {
		t.Fatal(err)
	}
	if ch, err := f.db.GetChannel(ctx, f.thread); err != nil || ch != nil {
		t.Errorf("thread survived its parent: %+v, %v", ch, err)
	}
}
