package db_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// threadCRUD is a text parent with a user and a helper that posts starters.
type threadCRUD struct {
	d      *db.DB
	user   int64
	parent int64
}

func newThreadCRUD(t *testing.T) threadCRUD {
	t.Helper()
	ctx := context.Background()
	d := openMigratedMemory(t)
	u, err := d.CreateUser(ctx, "crud", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	p, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	return threadCRUD{d: d, user: u, parent: p}
}

func (f threadCRUD) post(t *testing.T, channel int64, content string) int64 {
	t.Helper()
	id, err := f.d.CreateMessage(context.Background(), channel, f.user, content, nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return id
}

func (f threadCRUD) create(t *testing.T, name string) *db.ThreadInfo {
	t.Helper()
	th, created, err := f.d.CreateThread(context.Background(), db.NewThread{
		ParentID: f.parent, StarterMessageID: f.post(t, f.parent, "starter "+name),
		OwnerID: f.user, Name: name, AutoArchiveMinutes: 1440,
	})
	if err != nil || !created || th == nil {
		t.Fatalf("CreateThread(%q) = %+v, %v, %v", name, th, created, err)
	}
	return th
}

func (f threadCRUD) setActivity(t *testing.T, id int64, at string) {
	t.Helper()
	if _, err := f.d.ExecContext(context.Background(),
		`UPDATE channels SET thread_last_activity_at = ? WHERE id = ?`, at, id); err != nil {
		t.Fatal(err)
	}
}

func TestCreateThread_ReturnsTheRowAndIsIdempotentPerStarter(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "plans")
	if th.ParentID != f.parent || th.Name != "plans" || th.Archived || th.Locked || th.AutoArchiveMinutes != 1440 {
		t.Errorf("thread = %+v", th)
	}
	if th.OwnerID == nil || *th.OwnerID != f.user || th.StarterMessageID == nil {
		t.Errorf("owner/starter = %v/%v", th.OwnerID, th.StarterMessageID)
	}
	if th.MessageCount != 0 || th.LastMessageAt != nil {
		t.Errorf("an empty thread reports count %d last %v", th.MessageCount, th.LastMessageAt)
	}

	_, created, err := f.d.CreateThread(ctx, db.NewThread{
		ParentID: f.parent, StarterMessageID: *th.StarterMessageID, OwnerID: f.user, Name: "again", AutoArchiveMinutes: 60,
	})
	var exists *db.ThreadExistsError
	if created || !errors.Is(err, db.ErrThreadExists) || !errors.As(err, &exists) || exists.ThreadID != th.ID {
		t.Fatalf("second create = created %v, err %v, want ThreadExistsError naming %d", created, err, th.ID)
	}
	if exists.Error() == "" {
		t.Error("ThreadExistsError has no message")
	}
	if got, err := f.d.GetThreadByStarter(ctx, *th.StarterMessageID); err != nil || got == nil || got.ID != th.ID || got.Name != "plans" {
		t.Errorf("GetThreadByStarter = %+v, %v", got, err)
	}
}

func TestCreateThread_RefusesAnUnavailableStarter(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	other, err := f.d.CreateChannel(ctx, "other", "text", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	deleted := f.post(t, f.parent, "gone")
	if err := f.d.DeleteMessage(ctx, deleted, f.user, false); err != nil {
		t.Fatal(err)
	}
	system := f.post(t, f.parent, "joined")
	if _, err := f.d.ExecContext(ctx, `UPDATE messages SET kind = 1 WHERE id = ?`, system); err != nil {
		t.Fatal(err)
	}
	for name, starter := range map[string]int64{
		"missing":        987654,
		"deleted":        deleted,
		"system message": system,
		"other channel":  f.post(t, other, "elsewhere"),
	} {
		th, created, err := f.d.CreateThread(ctx, db.NewThread{
			ParentID: f.parent, StarterMessageID: starter, OwnerID: f.user, Name: "x", AutoArchiveMinutes: 60,
		})
		if th != nil || created || !errors.Is(err, db.ErrThreadStarterInvalid) {
			t.Errorf("%s: = %+v, %v, %v, want ErrThreadStarterInvalid", name, th, created, err)
		}
	}
	var n int
	if err := f.d.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE type = 'thread'`).Scan(&n); err != nil || n != 0 {
		t.Errorf("a refused create left %d thread rows (%v)", n, err)
	}
}

func TestCreateThread_RefusedWhileOwnerIsErasing(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	starter := f.post(t, f.parent, "hello")
	if _, err := f.d.ExecContext(ctx, `INSERT INTO erasure_jobs (user_id, state) VALUES (?, 'queued')`, f.user); err != nil {
		t.Fatal(err)
	}
	_, _, err := f.d.CreateThread(ctx, db.NewThread{ParentID: f.parent, StarterMessageID: starter, OwnerID: f.user, Name: "x", AutoArchiveMinutes: 60})
	if !errors.Is(err, db.ErrAccountErasing) {
		t.Fatalf("err = %v, want ErrAccountErasing", err)
	}
}

func TestCreateThread_ClosedDatabaseSurfacesWrappedErrors(t *testing.T) {
	f := newThreadCRUD(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := f.d.CreateThread(ctx, db.NewThread{ParentID: f.parent, StarterMessageID: 1, OwnerID: f.user}); err == nil {
		t.Error("CreateThread on a cancelled context succeeded")
	}
	if _, err := f.d.UpdateThread(ctx, 1, db.ThreadPatch{}, true); err == nil {
		t.Error("UpdateThread on a cancelled context succeeded")
	}
	if _, err := f.d.GetThreadByStarter(ctx, 1); err == nil {
		t.Error("GetThreadByStarter on a cancelled context succeeded")
	}
	if _, err := f.d.ListThreads(ctx, f.parent, false, db.ThreadCursor{}, 5); err == nil {
		t.Error("ListThreads on a cancelled context succeeded")
	}
	if _, err := f.d.DeleteThread(ctx, 1); err == nil {
		t.Error("DeleteThread on a cancelled context succeeded")
	}
	if _, _, err := f.d.NextThreadArchiveDue(ctx); err == nil {
		t.Error("NextThreadArchiveDue on a cancelled context succeeded")
	}
	if _, _, err := f.d.ArchiveDueThreads(ctx, time.Now(), 5); err == nil {
		t.Error("ArchiveDueThreads on a cancelled context succeeded")
	}
}

func TestGetThread_NilForOrdinaryChannelAndUnknownId(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	for _, id := range []int64{f.parent, 424242} {
		if got, err := f.d.GetThread(ctx, id); got != nil || err != nil {
			t.Errorf("GetThread(%d) = %+v, %v, want nil, nil", id, got, err)
		}
	}
	if got, err := f.d.GetThreadByStarter(ctx, 424242); got != nil || err != nil {
		t.Errorf("GetThreadByStarter(unknown) = %+v, %v", got, err)
	}
}

func TestThreadCountsOnlyLiveUserMessagesAndPostReopens(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "busy")
	first := f.post(t, th.ID, "one")
	f.post(t, th.ID, "two")
	if err := f.d.DeleteMessage(ctx, first, f.user, false); err != nil {
		t.Fatal(err)
	}
	got, err := f.d.GetThread(ctx, th.ID)
	if err != nil || got == nil {
		t.Fatalf("GetThread = %+v, %v", got, err)
	}
	if got.MessageCount != 1 || got.LastMessageAt == nil {
		t.Errorf("count %d last %v, want 1 live message", got.MessageCount, got.LastMessageAt)
	}

	f.setActivity(t, th.ID, "2020-01-01T00:00:00Z")
	if _, err := f.d.UpdateThread(ctx, th.ID, db.ThreadPatch{Archived: new(true)}, true); err != nil {
		t.Fatal(err)
	}
	// The production post path (it touches the thread in its own transaction).
	if _, err := f.d.CreateMessageWithMentions(ctx, th.ID, f.user, "wake up", nil, nil, 0, false, nil); err != nil {
		t.Fatal(err)
	}
	got, err = f.d.GetThread(ctx, th.ID)
	if err != nil || got == nil || got.Archived {
		t.Fatalf("after a post thread = %+v, %v, want reopened", got, err)
	}
	var act string
	if err := f.d.QueryRowContext(ctx, `SELECT thread_last_activity_at FROM channels WHERE id = ?`, th.ID).Scan(&act); err != nil || act <= "2020-01-01T00:00:00Z" {
		t.Errorf("activity = %q (%v), want a fresh time", act, err)
	}
}

func TestUpdateThread_AppliesPatchAndHonoursLock(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "old")

	got, err := f.d.UpdateThread(ctx, th.ID, db.ThreadPatch{
		Name: new("new"), Locked: new(true), AutoArchiveMinutes: new(60),
	}, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "new" || !got.Locked || got.AutoArchiveMinutes != 60 || got.Archived {
		t.Errorf("after patch = %+v", got)
	}

	if _, err := f.d.UpdateThread(ctx, th.ID, db.ThreadPatch{Name: new("sneaky")}, false); !errors.Is(err, db.ErrThreadLockedForActor) {
		t.Fatalf("non-moderator on locked thread: err = %v", err)
	}
	if cur, _ := f.d.GetThread(ctx, th.ID); cur == nil || cur.Name != "new" {
		t.Errorf("a refused update changed the thread: %+v", cur)
	}
	got, err = f.d.UpdateThread(ctx, th.ID, db.ThreadPatch{Locked: new(false), Archived: new(true)}, true)
	if err != nil || got.Locked || !got.Archived {
		t.Fatalf("moderator update = %+v, %v", got, err)
	}

	f.setActivity(t, th.ID, "2020-01-01T00:00:00Z")
	got, err = f.d.UpdateThread(ctx, th.ID, db.ThreadPatch{Archived: new(false)}, false)
	if err != nil || got.Archived {
		t.Fatalf("unarchive = %+v, %v", got, err)
	}
	var act string
	if err := f.d.QueryRowContext(ctx, `SELECT thread_last_activity_at FROM channels WHERE id = ?`, th.ID).Scan(&act); err != nil || act <= "2020-01-01T00:00:00Z" {
		t.Errorf("unarchive left activity %q (%v), want the idle clock restarted", act, err)
	}

	if _, err := f.d.UpdateThread(ctx, 999999, db.ThreadPatch{}, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("unknown thread: err = %v, want ErrNotFound", err)
	}
	if _, err := f.d.UpdateThread(ctx, f.parent, db.ThreadPatch{Name: new("x")}, true); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("ordinary channel: err = %v, want ErrNotFound", err)
	}
}

func TestListThreads_KeysetPagesByActivityAndFiltersArchived(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	a, b, c, d := f.create(t, "a"), f.create(t, "b"), f.create(t, "c"), f.create(t, "d")
	f.setActivity(t, a.ID, "2024-01-01T00:00:00Z")
	f.setActivity(t, b.ID, "2024-01-03T00:00:00Z")
	f.setActivity(t, c.ID, "2024-01-03T00:00:00Z") // ties b: higher id first
	f.setActivity(t, d.ID, "2024-01-02T00:00:00Z")
	if _, err := f.d.UpdateThread(ctx, d.ID, db.ThreadPatch{Archived: new(true)}, true); err != nil {
		t.Fatal(err)
	}
	// A thread of another parent never shows up.
	other, err := f.d.CreateChannel(ctx, "other", "text", "", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.d.CreateThread(ctx, db.NewThread{ParentID: other, StarterMessageID: f.post(t, other, "s"), OwnerID: f.user, Name: "z", AutoArchiveMinutes: 60}); err != nil {
		t.Fatal(err)
	}

	page1, err := f.d.ListThreads(ctx, f.parent, false, db.ThreadCursor{}, 2)
	if err != nil || len(page1) != 2 || page1[0].ID != c.ID || page1[1].ID != b.ID {
		t.Fatalf("page 1 = %+v, %v, want c then b", page1, err)
	}
	if cur := page1[1].Cursor(); cur.ID != b.ID || cur.Activity != "2024-01-03T00:00:00Z" {
		t.Errorf("cursor = %+v", cur)
	}
	// Activity in the cursor thread between pages must not move the page.
	f.setActivity(t, b.ID, "2030-01-01T00:00:00Z")
	page2, err := f.d.ListThreads(ctx, f.parent, false, page1[1].Cursor(), 2)
	if err != nil || len(page2) != 1 || page2[0].ID != a.ID {
		t.Fatalf("page 2 = %+v, %v, want only a", page2, err)
	}
	archived, err := f.d.ListThreads(ctx, f.parent, true, db.ThreadCursor{}, 10)
	if err != nil || len(archived) != 1 || archived[0].ID != d.ID || !archived[0].Archived {
		t.Fatalf("archived list = %+v, %v", archived, err)
	}
	empty, err := f.d.ListThreads(ctx, f.parent, false, db.ThreadCursor{Activity: "2000-01-01T00:00:00Z", ID: 1}, 10)
	if err != nil || len(empty) != 0 {
		t.Errorf("past the end = %+v, %v", empty, err)
	}
}

func TestDeleteThread_RemovesRowAndMessagesOnlyForThreads(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "doomed")
	msg := f.post(t, th.ID, "inside")

	if ok, err := f.d.DeleteThread(ctx, f.parent); err != nil || ok {
		t.Errorf("DeleteThread(ordinary channel) = %v, %v, want false", ok, err)
	}
	if ok, err := f.d.DeleteThread(ctx, th.ID); err != nil || !ok {
		t.Fatalf("DeleteThread = %v, %v", ok, err)
	}
	if ok, err := f.d.DeleteThread(ctx, th.ID); err != nil || ok {
		t.Errorf("second DeleteThread = %v, %v, want false", ok, err)
	}
	if m, err := f.d.GetMessage(ctx, msg); err == nil && m != nil {
		t.Errorf("thread message survived: %+v", m)
	}
	if ch, err := f.d.GetChannel(ctx, f.parent); err != nil || ch == nil {
		t.Errorf("parent channel gone: %v, %v", ch, err)
	}
}

func TestThreadArchiveSweep(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	if _, ok, err := f.d.NextThreadArchiveDue(ctx); err != nil || ok {
		t.Fatalf("no threads: ok %v err %v, want not ok", ok, err)
	}
	short := f.create(t, "short") // 1440 min
	if _, err := f.d.UpdateThread(ctx, short.ID, db.ThreadPatch{AutoArchiveMinutes: new(60)}, true); err != nil {
		t.Fatal(err)
	}
	long := f.create(t, "long")
	f.setActivity(t, short.ID, "2024-01-01T00:00:00Z")
	f.setActivity(t, long.ID, "2024-01-01T00:00:00Z")

	due, ok, err := f.d.NextThreadArchiveDue(ctx)
	if err != nil || !ok || !due.Equal(time.Date(2024, 1, 1, 1, 0, 0, 0, time.UTC)) {
		t.Fatalf("next due = %v, %v, %v, want 01:00 on the short thread", due, ok, err)
	}

	// Before anything is due nothing is archived.
	got, listed, err := f.d.ArchiveDueThreads(ctx, due.Add(-time.Second), 10)
	if err != nil || len(got) != 0 || listed != 0 {
		t.Fatalf("early sweep = %+v, %d, %v", got, listed, err)
	}
	got, listed, err = f.d.ArchiveDueThreads(ctx, due, 10)
	if err != nil || listed != 1 || len(got) != 1 || got[0].ID != short.ID || got[0].ParentID != f.parent {
		t.Fatalf("sweep = %+v, %d, %v, want the short thread only", got, listed, err)
	}
	if cur, _ := f.d.GetThread(ctx, short.ID); cur == nil || !cur.Archived {
		t.Errorf("short thread not archived: %+v", cur)
	}
	if cur, _ := f.d.GetThread(ctx, long.ID); cur == nil || cur.Archived {
		t.Errorf("long thread archived early: %+v", cur)
	}
	// A repeat finds nothing; the next due moves on to the long thread.
	if got, _, err = f.d.ArchiveDueThreads(ctx, due, 10); err != nil || len(got) != 0 {
		t.Errorf("repeat sweep = %+v, %v", got, err)
	}
	next, ok, err := f.d.NextThreadArchiveDue(ctx)
	if err != nil || !ok || !next.Equal(time.Date(2024, 1, 2, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("next due = %v, %v, %v, want 2024-01-02", next, ok, err)
	}
}

func TestMessageHistoryCarriesTheThreadOnItsStarter(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "attached")
	f.post(t, th.ID, "reply")
	plain := f.post(t, f.parent, "no thread")

	msgs, err := f.d.GetMessagesForAPI(ctx, f.parent, 0, 50, f.user)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[int64]db.MessageAPIResponse{}
	for _, m := range msgs {
		byID[m.ID] = m
	}
	s := byID[*th.StarterMessageID]
	if s.Thread == nil || s.Thread.ID != th.ID || s.Thread.MessageCount != 1 {
		t.Errorf("starter thread = %+v", s.Thread)
	}
	if byID[plain].Thread != nil {
		t.Errorf("a plain message carries a thread: %+v", byID[plain].Thread)
	}
}

func TestChannelThreadHelpers(t *testing.T) {
	f := newThreadCRUD(t)
	ctx := context.Background()
	th := f.create(t, "helpers")
	tc, err := f.d.GetChannel(ctx, th.ID)
	if err != nil || tc == nil {
		t.Fatalf("GetChannel(thread) = %+v, %v", tc, err)
	}
	if !tc.IsThread() || tc.AuthorityID() != f.parent || tc.Thread.ParentID != f.parent {
		t.Errorf("thread channel = %+v, authority %d", tc.Thread, tc.AuthorityID())
	}
	pc, err := f.d.GetChannel(ctx, f.parent)
	if err != nil || pc == nil || pc.IsThread() || pc.AuthorityID() != f.parent {
		t.Errorf("parent channel IsThread/AuthorityID wrong: %+v, %v", pc, err)
	}
	if !db.IsThreadParentType("text") || db.IsThreadParentType("voice") || db.IsThreadParentType("thread") {
		t.Error("IsThreadParentType accepts a type other than text")
	}
}
