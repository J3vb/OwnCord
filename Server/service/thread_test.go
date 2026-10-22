package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// bg is the test context. Tests call it inline rather than holding a ctx
// variable, so the fixture helpers (which own their context) are not
// reported by contextcheck.
func bg() context.Context { return context.Background() }

const (
	thrParent = 10
	thrOwner  = 1
	thrOther  = 2
	thrMod    = 3
)

type threadFixture struct {
	database *db.DB
	msgs     *MessageService
	threads  *ThreadService
	perms    *PermissionService
}

func newThreadFixture(t *testing.T) *threadFixture {
	t.Helper()
	database := newTestDB(t)
	seedRole(t, database, &db.Role{
		ID: permissions.MemberRoleID, Name: "member", Position: 1,
		Permissions: permissions.SendMessages | permissions.ReadMessages,
	})
	seedRole(t, database, &db.Role{
		ID: permissions.ModeratorRoleID, Name: "moderator", Position: 60,
		Permissions: permissions.SendMessages | permissions.ReadMessages | permissions.ManageMessages,
	})
	seedUser(t, database, &db.User{ID: thrOwner, Username: "alice", Status: "online"})
	seedUser(t, database, &db.User{ID: thrOther, Username: "bob", Status: "online"})
	seedUser(t, database, &db.User{ID: thrMod, Username: "mod", Status: "online"})
	seedUserRole(t, database, thrOwner, permissions.MemberRoleID)
	seedUserRole(t, database, thrOther, permissions.MemberRoleID)
	seedUserRole(t, database, thrMod, permissions.ModeratorRoleID)
	seedChannel(t, database, &db.Channel{ID: thrParent, Name: "general", Type: "text"})
	perms := NewPermissionService(database, permissions.NewChecker(database))
	return &threadFixture{
		database: database,
		msgs:     NewMessageService(database, perms, nil),
		threads:  NewThreadService(database, perms, auth.NewRateLimiter()),
		perms:    perms,
	}
}

func (f *threadFixture) post(t *testing.T, channelID, userID int64, text string) int64 {
	t.Helper()
	res, err := f.msgs.SendMessage(context.Background(), SendMessageParams{
		ChannelID: channelID, UserID: userID, Username: "u", RoleName: "member", Content: text,
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	return res.MessageID
}

func (f *threadFixture) start(t *testing.T, userID int64, name string) *db.ThreadInfo {
	t.Helper()
	starter := f.post(t, thrParent, userID, "starter "+name)
	info, created, err := f.threads.Create(context.Background(), CreateThreadParams{
		UserID: userID, ChannelID: thrParent, MessageID: starter, Name: name,
	})
	if err != nil || !created {
		t.Fatalf("Create: created=%v err=%v", created, err)
	}
	return info
}

func TestThreadCreate_Valid(t *testing.T) {
	f := newThreadFixture(t)
	info := f.start(t, thrOwner, "  Plans  ")
	if info.Name != "Plans" || info.ParentID != thrParent || info.Archived || info.Locked {
		t.Fatalf("thread = %+v", info)
	}
	if info.AutoArchiveMinutes != DefaultThreadAutoArchiveMinutes {
		t.Fatalf("auto archive = %d", info.AutoArchiveMinutes)
	}
	// The starter message carries the thread in history.
	msgs, err := f.database.GetMessagesForAPI(context.Background(), thrParent, 0, 10, thrOwner)
	if err != nil {
		t.Fatalf("GetMessages: %v", err)
	}
	var seen bool
	for _, m := range msgs {
		if info.StarterMessageID != nil && m.ID == *info.StarterMessageID {
			seen = m.Thread != nil && m.Thread.ID == info.ID
		}
	}
	if !seen {
		t.Fatal("starter message has no thread summary")
	}
}

func TestThreadCreate_Validation(t *testing.T) {
	f := newThreadFixture(t)
	starter := f.post(t, thrParent, thrOwner, "x")
	cases := map[string]CreateThreadParams{
		"empty name":   {UserID: thrOwner, ChannelID: thrParent, MessageID: starter, Name: "  "},
		"bad archive":  {UserID: thrOwner, ChannelID: thrParent, MessageID: starter, Name: "a", AutoArchiveMinutes: 7},
		"long name":    {UserID: thrOwner, ChannelID: thrParent, MessageID: starter, Name: string(make([]rune, 101))},
		"missing msg":  {UserID: thrOwner, ChannelID: thrParent, MessageID: 9999, Name: "a"},
		"no channel":   {UserID: thrOwner, ChannelID: 9999, MessageID: starter, Name: "a"},
		"zero message": {UserID: thrOwner, ChannelID: thrParent, Name: "a"},
	}
	for name, p := range cases {
		if _, _, err := f.threads.Create(bg(), p); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

// A thread cannot start on a message of another channel, a deleted message or
// a thread's own message.
func TestThreadCreate_StarterRules(t *testing.T) {
	f := newThreadFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 11, Name: "other", Type: "text"})
	foreign := f.post(t, 11, thrOwner, "elsewhere")
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: foreign, Name: "a"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign starter err = %v, want ErrNotFound", err)
	}
	gone := f.post(t, thrParent, thrOwner, "gone")
	if _, err := f.database.ExecContext(bg(), `UPDATE messages SET deleted = 1 WHERE id = ?`, gone); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: gone, Name: "a"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted starter err = %v, want ErrNotFound", err)
	}
	th := f.start(t, thrOwner, "t")
	inThread := f.post(t, th.ID, thrOwner, "in thread")
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: th.ID, MessageID: inThread, Name: "nested"}); err == nil {
		t.Fatal("a thread started inside a thread")
	}
}

// Two creates race on one message: exactly one wins and the loser is told the
// winner's id.
func TestThreadCreate_Race(t *testing.T) {
	f := newThreadFixture(t)
	starter := f.post(t, thrParent, thrOwner, "contested")
	const n = 8
	var wg sync.WaitGroup
	barrier := make(chan struct{})
	type outcome struct {
		info    *db.ThreadInfo
		created bool
		err     error
	}
	out := make([]outcome, n)
	for i := range n {
		uid := int64(thrOwner)
		if i%2 == 1 {
			uid = thrOther
		}
		wg.Go(func() {
			<-barrier
			info, created, err := f.threads.Create(context.Background(), CreateThreadParams{
				UserID: uid, ChannelID: thrParent, MessageID: starter, Name: fmt.Sprintf("t%d", i),
			})
			out[i] = outcome{info, created, err}
		})
	}
	close(barrier)
	wg.Wait()
	var winner int64
	for _, o := range out {
		if o.err == nil && o.created {
			if winner != 0 {
				t.Fatal("two creates won")
			}
			winner = o.info.ID
		}
	}
	if winner == 0 {
		t.Fatalf("no create won: %+v", out)
	}
	for _, o := range out {
		if o.err == nil {
			if o.info.ID != winner {
				t.Fatalf("a loser got thread %d, winner is %d", o.info.ID, winner)
			}
			continue
		}
		var exists *ThreadExistsError
		if !errors.As(o.err, &exists) || exists.ThreadID != winner || !errors.Is(o.err, ErrConflict) {
			t.Fatalf("loser err = %v, want ThreadExistsError for %d", o.err, winner)
		}
	}
}

// The unique starter makes a create idempotent: the owner's retry gets the
// thread back (and costs no rate token); anyone else is told it exists.
func TestThreadCreate_RetryByOwnerIsIdempotent(t *testing.T) {
	f := newThreadFixture(t)
	starter := f.post(t, thrParent, thrOwner, "s")
	p := CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: starter, Name: "once"}
	first, created, err := f.threads.Create(context.Background(), p)
	if err != nil || !created {
		t.Fatalf("first: created=%v err=%v", created, err)
	}
	for range 2 * threadCreateLimit {
		again, created, err := f.threads.Create(context.Background(), p)
		if err != nil || created || again.ID != first.ID {
			t.Fatalf("retry: %+v created=%v err=%v, want thread %d", again, created, err, first.ID)
		}
	}
	p.UserID = thrOther
	_, _, err = f.threads.Create(context.Background(), p)
	var exists *ThreadExistsError
	if !errors.As(err, &exists) || exists.ThreadID != first.ID {
		t.Fatalf("other user err = %v, want ThreadExistsError for %d", err, first.ID)
	}
}

func TestThreadCreate_RateLimited(t *testing.T) {
	f := newThreadFixture(t)
	for i := range threadCreateLimit {
		f.start(t, thrOwner, fmt.Sprintf("t%d", i))
	}
	starter := f.post(t, thrParent, thrOwner, "one too many")
	_, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: starter, Name: "x"})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
}

func TestThreadCreate_NeedsSendOnParent(t *testing.T) {
	f := newThreadFixture(t)
	starter := f.post(t, thrParent, thrOwner, "s")
	seedChannelOverride(t, f.database, permissions.MemberRoleID, thrParent, 0, permissions.SendMessages)
	_, _, err := f.threads.Create(context.Background(), CreateThreadParams{UserID: thrOther, ChannelID: thrParent, MessageID: starter, Name: "x"})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
}

// The owner and moderator matrix for update and delete, including a locked
// thread.
func TestThreadUpdateDelete_Matrix(t *testing.T) {
	rename := func(s string) *string { return &s }
	yes, no := true, false

	t.Run("owner renames and archives", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		got, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: rename("b"), Archived: &yes})
		if err != nil || got.Name != "b" || !got.Archived {
			t.Fatalf("got %+v err %v", got, err)
		}
		got, err = f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Archived: &no})
		if err != nil || got.Archived {
			t.Fatalf("unarchive: %+v err %v", got, err)
		}
	})
	t.Run("stranger cannot", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOther, ThreadID: th.ID, Name: rename("x")}); !errors.Is(err, ErrForbidden) {
			t.Fatalf("update err = %v", err)
		}
		if _, err := f.threads.Delete(bg(), thrOther, th.ID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("delete err = %v", err)
		}
	})
	t.Run("owner cannot lock or delete", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Locked: &yes}); !errors.Is(err, ErrForbidden) {
			t.Fatalf("lock err = %v", err)
		}
		if _, err := f.threads.Delete(bg(), thrOwner, th.ID); !errors.Is(err, ErrForbidden) {
			t.Fatalf("delete err = %v", err)
		}
	})
	t.Run("moderator locks, owner is then refused", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		got, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: th.ID, Locked: &yes, Archived: &yes})
		if err != nil || !got.Locked || !got.Archived {
			t.Fatalf("mod lock: %+v err %v", got, err)
		}
		_, err = f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Archived: &no})
		if !errors.Is(err, permissions.ErrThreadLocked) {
			t.Fatalf("owner unarchive of a locked thread err = %v, want ErrThreadLocked", err)
		}
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: rename("z")}); !errors.Is(err, permissions.ErrThreadLocked) {
			t.Fatalf("owner rename of a locked thread err = %v", err)
		}
		got, err = f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: th.ID, Locked: &no, Archived: &no})
		if err != nil || got.Locked || got.Archived {
			t.Fatalf("mod unlock: %+v err %v", got, err)
		}
	})
	t.Run("moderator deletes and the thread is gone", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		f.post(t, th.ID, thrOwner, "in thread")
		gone, err := f.threads.Delete(bg(), thrMod, th.ID)
		if err != nil || gone.ID != th.ID {
			t.Fatalf("delete: %+v err %v", gone, err)
		}
		if _, err := f.threads.Delete(bg(), thrMod, th.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("second delete err = %v, want ErrNotFound", err)
		}
		// The starter can host a new thread again.
		if _, created, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: *th.StarterMessageID, Name: "again"}); err != nil || !created {
			t.Fatalf("recreate: created=%v err=%v", created, err)
		}
	})
	t.Run("bad auto archive and empty patch", func(t *testing.T) {
		f := newThreadFixture(t)
		th := f.start(t, thrOwner, "a")
		bad := 5
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, AutoArchiveMinutes: &bad}); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("err = %v", err)
		}
		if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID}); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("err = %v", err)
		}
	})
}

// A post to an archived thread reopens it in the send transaction; a locked
// thread refuses a member's post and admits a moderator's.
func TestThread_PostUnarchivesAndLockRefuses(t *testing.T) {
	f := newThreadFixture(t)
	yes := true
	th := f.start(t, thrOwner, "a")
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Archived: &yes}); err != nil {
		t.Fatal(err)
	}
	f.post(t, th.ID, thrOther, "wake up")
	got, err := f.threads.Get(bg(), th.ID)
	if err != nil || got.Archived || got.MessageCount != 1 {
		t.Fatalf("after post: %+v err %v", got, err)
	}

	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: th.ID, Locked: &yes}); err != nil {
		t.Fatal(err)
	}
	_, err = f.msgs.SendMessage(bg(), SendMessageParams{ChannelID: th.ID, UserID: thrOther, Username: "bob", RoleName: "member", Content: "locked out"})
	if !errors.Is(err, permissions.ErrThreadLocked) {
		t.Fatalf("member post to locked thread err = %v, want ErrThreadLocked", err)
	}
	if _, err := f.msgs.SendMessage(bg(), SendMessageParams{ChannelID: th.ID, UserID: thrMod, Username: "mod", RoleName: "moderator", Content: "ok"}); err != nil {
		t.Fatalf("moderator post to locked thread: %v", err)
	}
}

func TestThreadList_PaginationAndGate(t *testing.T) {
	f := newThreadFixture(t)
	ids := make([]int64, 0, 3)
	base := time.Now().UTC().Add(-time.Hour)
	for i := range 3 {
		th := f.start(t, thrMod, fmt.Sprintf("t%d", i)) // mod: not rate limited by the owner's budget
		ids = append(ids, th.ID)
		setActivity(t, f, th.ID, base.Add(time.Duration(i)*time.Minute))
	}
	yes := true
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrMod, ThreadID: ids[0], Archived: &yes}); err != nil {
		t.Fatal(err)
	}
	page, next, more, err := f.threads.List(bg(), thrOther, thrParent, false, ThreadCursor{}, 1)
	if err != nil || !more || len(page) != 1 || page[0].ID != ids[2] {
		t.Fatalf("page 1 = %+v more=%v err=%v, want newest %d", page, more, err, ids[2])
	}
	// Activity in the cursor thread between pages must not move the page: the
	// cursor is a value, not a thread to look up again.
	setActivity(t, f, ids[2], base.Add(-24*time.Hour))
	page, _, _, err = f.threads.List(bg(), thrOther, thrParent, false, next, 1)
	if err != nil || len(page) != 1 || page[0].ID != ids[1] {
		t.Fatalf("page 2 = %+v err=%v, want %d", page, err, ids[1])
	}
	arch, _, _, err := f.threads.List(bg(), thrOther, thrParent, true, ThreadCursor{}, 10)
	if err != nil || len(arch) != 1 || arch[0].ID != ids[0] {
		t.Fatalf("archived = %+v err=%v", arch, err)
	}

	// The parent's read gate applies.
	seedChannelOverride(t, f.database, permissions.MemberRoleID, thrParent, 0, permissions.ReadMessages)
	f.perms.InvalidateAll()
	if _, _, _, err := f.threads.List(bg(), thrOther, thrParent, false, ThreadCursor{}, 10); err == nil {
		t.Fatal("a member who cannot read the parent listed its threads")
	}
	// A thread id is not a parent.
	if _, _, _, err := f.threads.List(bg(), thrMod, ids[1], false, ThreadCursor{}, 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("listing a thread's threads err = %v", err)
	}
}

func TestThreadCursor_RoundTripAndRejects(t *testing.T) {
	c := ThreadCursor{Activity: "2026-10-21T09:30:00Z", ID: 42}
	got, err := ParseThreadCursor(FormatThreadCursor(c))
	if err != nil || got != c {
		t.Fatalf("round trip = %+v, %v", got, err)
	}
	if first, err := ParseThreadCursor(""); err != nil || first != (ThreadCursor{}) {
		t.Fatalf("empty = %+v, %v", first, err)
	}
	for _, bad := range []string{"42", "x_y", "2026-10-21T09:30:00Z_0", "notatime_5"} {
		if _, err := ParseThreadCursor(bad); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%q err = %v, want ErrBadRequest", bad, err)
		}
	}
}
