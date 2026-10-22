package service

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

func (f *threadFixture) followersOf(t *testing.T, threadID int64) []int64 {
	t.Helper()
	ids, err := f.threads.Followers(context.Background(), threadID)
	if err != nil {
		t.Fatalf("Followers: %v", err)
	}
	return ids
}

func TestThreadFollow_CreateJoinsTheOwner(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "plans")
	if got := f.followersOf(t, th.ID); !slices.Equal(got, []int64{thrOwner}) {
		t.Fatalf("followers = %v, want the owner", got)
	}
}

func TestThreadFollow_PostAndMentionJoinAndReportTheNewOnes(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	th := f.start(t, thrOwner, "plans")

	res, err := f.msgs.SendMessage(ctx, SendMessageParams{
		ChannelID: th.ID, UserID: thrOther, Username: "bob", RoleName: "member", Content: "hello @mod",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	slices.Sort(res.ThreadJoined)
	if want := []int64{thrOther, thrMod}; !slices.Equal(res.ThreadJoined, want) {
		t.Fatalf("ThreadJoined = %v, want %v", res.ThreadJoined, want)
	}
	// Everyone is already in: the next post reports nobody.
	res, err = f.msgs.SendMessage(ctx, SendMessageParams{
		ChannelID: th.ID, UserID: thrOwner, Username: "alice", RoleName: "member", Content: "hi @bob",
	})
	if err != nil || len(res.ThreadJoined) != 0 {
		t.Fatalf("second post = %+v, %v; want no new followers", res, err)
	}
	// A post in the ordinary channel reports none.
	res, err = f.msgs.SendMessage(ctx, SendMessageParams{
		ChannelID: thrParent, UserID: thrOther, Username: "bob", RoleName: "member", Content: "plain",
	})
	if err != nil || res.ThreadJoined != nil {
		t.Fatalf("channel post = %+v, %v; want nil ThreadJoined", res, err)
	}
}

func TestThreadSetFollow_GateIdempotenceAndStorage(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	th := f.start(t, thrOwner, "plans")

	for range 2 {
		info, err := f.threads.SetFollow(ctx, thrOther, th.ID, true)
		if err != nil || info.ID != th.ID {
			t.Fatalf("follow = %v, %v", info, err)
		}
	}
	if !slices.Contains(f.followersOf(t, th.ID), thrOther) {
		t.Fatal("follow not stored")
	}
	for range 2 {
		if _, err := f.threads.SetFollow(ctx, thrOther, th.ID, false); err != nil {
			t.Fatalf("unfollow: %v", err)
		}
	}
	if slices.Contains(f.followersOf(t, th.ID), thrOther) {
		t.Fatal("unfollow not stored")
	}
	// Locked and archived threads can still be followed.
	locked, archived := true, true
	if _, err := f.threads.Update(ctx, UpdateThreadParams{UserID: thrMod, ThreadID: th.ID, Locked: &locked, Archived: &archived}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := f.threads.SetFollow(ctx, thrOther, th.ID, true); err != nil {
		t.Fatalf("follow a locked, archived thread: %v", err)
	}

	if _, err := f.threads.SetFollow(ctx, thrOther, 0, true); !errors.Is(err, ErrBadRequest) {
		t.Errorf("following id 0 = %v, want ErrBadRequest", err)
	}
	if _, err := f.threads.SetFollow(ctx, thrOther, 99999, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("following an unknown id = %v, want ErrNotFound", err)
	}
	if _, err := f.threads.SetFollow(ctx, thrOther, thrParent, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("following an ordinary channel = %v, want ErrNotFound", err)
	}

	// A user who cannot read the parent does not see the thread.
	if err := f.database.UpsertChannelUserOverride(ctx, thrParent, thrOther, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.perms.InvalidateAll()
	if _, err := f.threads.SetFollow(ctx, thrOther, th.ID, true); !errors.Is(err, ErrNotFound) {
		t.Errorf("follow without parent READ = %v, want ErrNotFound", err)
	}
}

func TestThreadFollowed_FiltersByReadableParentAndSkipsArchived(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	open := f.start(t, thrOwner, "open")
	gone := f.start(t, thrOwner, "archived")
	archived := true
	if _, err := f.threads.Update(ctx, UpdateThreadParams{UserID: thrOwner, ThreadID: gone.ID, Archived: &archived}); err != nil {
		t.Fatal(err)
	}

	got, err := f.threads.Followed(ctx, thrOwner, map[int64]struct{}{thrParent: {}})
	if err != nil || len(got) != 1 || got[0].Thread.ID != open.ID {
		t.Fatalf("Followed = %+v, %v; want the open thread only", got, err)
	}
	if got, err := f.threads.Followed(ctx, thrOwner, map[int64]struct{}{}); err != nil || len(got) != 0 {
		t.Fatalf("Followed with no readable parent = %+v, %v; want none", got, err)
	}
}

func TestThreadDeleteNotifying_ReturnsTheFollowersItTook(t *testing.T) {
	f := newThreadFixture(t)
	ctx := context.Background()
	th := f.start(t, thrOwner, "plans")
	if _, err := f.threads.SetFollow(ctx, thrOther, th.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, followers, err := f.threads.DeleteNotifying(ctx, thrOther, th.ID); !errors.Is(err, ErrForbidden) || followers != nil {
		t.Fatalf("delete by a non-moderator = %v, %v", followers, err)
	}
	info, followers, err := f.threads.DeleteNotifying(ctx, thrMod, th.ID)
	if err != nil || info.ID != th.ID {
		t.Fatalf("DeleteNotifying = %v, %v", info, err)
	}
	slices.Sort(followers)
	if want := []int64{thrOwner, thrOther}; !slices.Equal(followers, want) {
		t.Fatalf("followers = %v, want %v", followers, want)
	}
}

func TestThreadFollow_StoreWithoutFollowSliceIsInternal(t *testing.T) {
	f := newThreadFixture(t)
	// struct{ Store } exposes only Store's methods, so the follow slice is absent.
	svc := &ThreadService{st: struct{ Store }{f.database}, ts: f.database, perms: f.perms}
	ctx := context.Background()
	if _, err := svc.Followers(ctx, 1); !errors.Is(err, ErrInternal) {
		t.Fatalf("Followers = %v, want ErrInternal", err)
	}
	if _, err := svc.SetFollow(ctx, thrOther, 1, true); !errors.Is(err, ErrInternal) {
		t.Fatalf("SetFollow = %v, want ErrInternal", err)
	}
	if _, err := svc.Followed(ctx, thrOther, nil); !errors.Is(err, ErrInternal) {
		t.Fatalf("Followed = %v, want ErrInternal", err)
	}
}

var _ ThreadFollowStore = (*db.DB)(nil)
