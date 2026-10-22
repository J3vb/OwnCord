package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func followers(t *testing.T, d *db.DB, thread int64) []int64 {
	t.Helper()
	ids, err := d.ListThreadFollowers(context.Background(), thread)
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

func seedThreadUser(t *testing.T, d *db.DB, name string) int64 {
	t.Helper()
	id, err := d.CreateUser(context.Background(), name, "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// TestThreadPost_JoinsAuthorAndDirectMentionsOnly covers both send
// transactions: the author and each direct mention follow, an @everyone does
// not, and only a user the call newly inserted is reported.
func TestThreadPost_JoinsAuthorAndDirectMentionsOnly(t *testing.T) {
	for _, path := range []string{"mentions", "delivery"} {
		t.Run(path, func(t *testing.T) {
			f := newThreadFixture(t)
			bob := seedThreadUser(t, f.db, "bob")
			carol := seedThreadUser(t, f.db, "carol")
			dave := seedThreadUser(t, f.db, "dave")
			author := seedThreadUser(t, f.db, "poster")

			send := func(everyone bool, mentioned ...int64) *db.Message {
				t.Helper()
				if path == "mentions" {
					m, err := f.db.CreateMessageWithMentions(context.Background(), f.thread, author, "hi", nil, mentioned, 0, everyone, nil)
					if err != nil {
						t.Fatal(err)
					}
					return m
				}
				p := storageDeliveryParams(author, f.thread)
				p.ClientMessageID = "m-" + t.Name() + string(rune('a'+len(followers(t, f.db, f.thread))))
				p.MentionedUserIDs, p.MentionsEveryone = mentioned, everyone
				got, err := f.db.CreateMessageDelivery(context.Background(), p)
				if err != nil {
					t.Fatal(err)
				}
				return got.Message
			}

			first := send(false, bob, carol)
			slices.Sort(first.ThreadJoined)
			want := []int64{author, bob, carol}
			slices.Sort(want)
			if !slices.Equal(first.ThreadJoined, want) {
				t.Fatalf("ThreadJoined = %v, want %v", first.ThreadJoined, want)
			}

			// INSERT OR IGNORE: bob and the author are already in, dave is new.
			second := send(false, bob, dave)
			if !slices.Equal(second.ThreadJoined, []int64{dave}) {
				t.Fatalf("second ThreadJoined = %v, want [%d]", second.ThreadJoined, dave)
			}

			// @everyone names nobody: no new follower, and the author is already in.
			third := send(true)
			if len(third.ThreadJoined) != 0 {
				t.Fatalf("@everyone ThreadJoined = %v, want none", third.ThreadJoined)
			}
			if got := followers(t, f.db, f.thread); len(got) != 4 {
				t.Fatalf("followers = %v, want author, bob, carol, dave", got)
			}
		})
	}
}

func TestThreadPost_InAnOrdinaryChannelJoinsNobody(t *testing.T) {
	f := newThreadFixture(t)
	m, err := f.db.CreateMessageWithMentions(context.Background(), f.parent, f.user, "hi", nil, []int64{f.user}, 0, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.ThreadJoined != nil {
		t.Fatalf("ThreadJoined = %v, want nil outside a thread", m.ThreadJoined)
	}
	var n int
	if err := f.db.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM thread_members`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("thread_members rows = %d (%v), want 0", n, err)
	}
}

func TestFollowThread_IsIdempotentBothWays(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	bob := seedThreadUser(t, f.db, "bob")

	for i, want := range []bool{true, false} {
		if got, err := f.db.FollowThread(ctx, f.thread, bob); err != nil || got != want {
			t.Fatalf("follow #%d = %v, %v; want %v", i+1, got, err, want)
		}
	}
	if ok, err := f.db.IsThreadFollower(ctx, f.thread, bob); err != nil || !ok {
		t.Fatalf("IsThreadFollower = %v, %v", ok, err)
	}
	for i, want := range []bool{true, false} {
		if got, err := f.db.UnfollowThread(ctx, f.thread, bob); err != nil || got != want {
			t.Fatalf("unfollow #%d = %v, %v; want %v", i+1, got, err, want)
		}
	}
	if ok, err := f.db.IsThreadFollower(ctx, f.thread, bob); err != nil || ok {
		t.Fatalf("IsThreadFollower after unfollow = %v, %v", ok, err)
	}
}

// A follow only ever names a thread: an ordinary channel id writes nothing,
// and the table's own trigger refuses a direct insert.
func TestFollowThread_RefusesANonThread(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	if got, err := f.db.FollowThread(ctx, f.parent, f.user); err != nil || got {
		t.Fatalf("FollowThread(parent) = %v, %v; want false, nil", got, err)
	}
	if err := f.exec(t, `INSERT INTO thread_members (thread_id, user_id) VALUES (?, ?)`, f.parent, f.user); err == nil {
		t.Fatal("direct insert for a text channel succeeded; the shape trigger should refuse it")
	}
}

func TestThreadMembers_CascadeOnThreadAndUserDelete(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	bob := seedThreadUser(t, f.db, "bob")
	for _, u := range []int64{f.user, bob} {
		if _, err := f.db.FollowThread(ctx, f.thread, u); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.exec(t, `DELETE FROM users WHERE id = ?`, bob); err != nil {
		t.Fatal(err)
	}
	if got := followers(t, f.db, f.thread); !slices.Equal(got, []int64{f.user}) {
		t.Fatalf("followers after user delete = %v, want [%d]", got, f.user)
	}
	if gone, err := f.db.DeleteThread(ctx, f.thread); err != nil || !gone {
		t.Fatalf("DeleteThread = %v, %v", gone, err)
	}
	if got := followers(t, f.db, f.thread); len(got) != 0 {
		t.Fatalf("followers after thread delete = %v, want none", got)
	}
}

func TestCreateThread_JoinsTheOwner(t *testing.T) {
	d := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedThreadUser(t, d, "owner")
	parent, err := d.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	starter, err := d.CreateMessage(ctx, parent, owner, "start", nil)
	if err != nil {
		t.Fatal(err)
	}
	info, created, err := d.CreateThread(ctx, db.NewThread{
		ParentID: parent, StarterMessageID: starter, OwnerID: owner, Name: "t", AutoArchiveMinutes: 1440,
	})
	if err != nil || !created {
		t.Fatalf("CreateThread = %v, %v", created, err)
	}
	if got := followers(t, d, info.ID); !slices.Equal(got, []int64{owner}) {
		t.Fatalf("followers = %v, want the owner", got)
	}
}

func TestListFollowedThreads_OpenOnlyWithReadPosition(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	bob := seedThreadUser(t, f.db, "bob")
	if _, err := f.db.FollowThread(ctx, f.thread, bob); err != nil {
		t.Fatal(err)
	}
	first, err := f.db.CreateMessageWithMentions(ctx, f.thread, f.user, "one", nil, nil, 0, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.CreateMessageWithMentions(ctx, f.thread, f.user, "two", nil, []int64{bob}, 0, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.exec(t, `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 3)`, bob, f.thread, first.ID); err != nil {
		t.Fatal(err)
	}
	got, err := f.db.ListFollowedThreads(ctx, bob)
	if err != nil || len(got) != 1 {
		t.Fatalf("ListFollowedThreads = %v, %v", got, err)
	}
	g := got[0]
	if g.Thread.ID != f.thread || g.UnreadCount != 1 || g.MentionCount != 3 || g.LastReadMessageID != first.ID || g.LastMessageID <= first.ID {
		t.Fatalf("row = %+v", g)
	}
	if err := f.exec(t, `UPDATE channels SET thread_archived = 1 WHERE id = ?`, f.thread); err != nil {
		t.Fatal(err)
	}
	if got, err := f.db.ListFollowedThreads(ctx, bob); err != nil || len(got) != 0 {
		t.Fatalf("archived thread listed: %v, %v", got, err)
	}
}
