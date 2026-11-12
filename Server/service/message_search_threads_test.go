package service

import (
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

const srchNSFWParent = 900

func searchedChannels(t *testing.T, f *forumPostFixture, userID int64, in SearchRequest) map[int64]bool {
	t.Helper()
	res, _, err := f.msgs.SearchMessages(bg(), userID, in)
	mustDo(t, "SearchMessages", err)
	got := map[int64]bool{}
	for i := range res {
		got[res[i].ChannelID] = true
	}
	return got
}

// threadAndPost puts 'needle' into a thread of the text channel and into a forum post.
func threadAndPost(t *testing.T, f *forumPostFixture) (threadID, postID int64) {
	t.Helper()
	th := f.start(t, thrOwner, "plans")
	f.post(t, th.ID, thrOwner, "needle in thread")
	res, err := f.limited.CreateForumPost(bg(), f.req(thrOwner, "Dark mode", "needle in post", 1))
	mustDo(t, "CreateForumPost", err)
	return th.ID, res.Thread.ID
}

func TestSearchMessages_FindsThreadsAndForumPosts(t *testing.T) {
	f := newForumPostFixture(t)
	threadID, postID := threadAndPost(t, f)

	topLevel := f.post(t, thrParent, thrOwner, "needle top level")

	got := searchedChannels(t, f, thrOther, SearchRequest{Query: "needle"})
	if !got[threadID] || !got[postID] || !got[thrParent] {
		t.Fatalf("global search channels = %v, want thread %d and post %d", got, threadID, postID)
	}

	res, _, err := f.msgs.SearchMessages(bg(), thrOther, SearchRequest{Query: "needle"})
	mustDo(t, "SearchMessages", err)
	sawTop := false
	for i := range res {
		sawTop = sawTop || res[i].MessageID == topLevel
		want := int64(0)
		switch res[i].ChannelID {
		case threadID:
			want = thrParent
		case postID:
			want = frmForum
		}
		if res[i].ThreadParentID != want {
			t.Errorf("hit in %d: ThreadParentID = %d, want %d", res[i].ChannelID, res[i].ThreadParentID, want)
		}
	}

	if !sawTop {
		t.Error("top-level hit missing")
	}

	forum := int64(frmForum)
	got = searchedChannels(t, f, thrOther, SearchRequest{Query: "needle", ChannelID: &forum})
	if !got[postID] || got[threadID] {
		t.Fatalf("forum-scoped channels = %v, want only post %d", got, postID)
	}

	text := int64(thrParent)
	got = searchedChannels(t, f, thrOther, SearchRequest{Query: "needle", ChannelID: &text})
	if !got[threadID] || got[postID] {
		t.Fatalf("text-scoped channels = %v, want only thread %d", got, threadID)
	}

	got = searchedChannels(t, f, thrOther, SearchRequest{Query: "needle", ChannelID: &threadID})
	if !got[threadID] || len(got) != 1 {
		t.Fatalf("thread-scoped channels = %v, want only thread %d", got, threadID)
	}

	got = searchedChannels(t, f, thrOther, SearchRequest{Query: "needle in:ideas"})
	if !got[postID] || got[threadID] {
		t.Fatalf("in:forum channels = %v, want only post %d", got, postID)
	}
}

// A thread is read through its parent: a member who cannot read the parent finds nothing in it.
func TestSearchMessages_ThreadOfUnreadableParentHidden(t *testing.T) {
	f := newForumPostFixture(t)
	threadID, postID := threadAndPost(t, f)
	for _, parent := range []int64{thrParent, frmForum} {
		mustDo(t, "override", f.database.UpsertChannelOverride(bg(), parent, permissions.MemberRoleID, 0, permissions.ReadMessages))
	}

	got := searchedChannels(t, f, thrOther, SearchRequest{Query: "needle"})
	if got[threadID] || got[postID] {
		t.Fatalf("channels = %v, want neither the thread nor the post", got)
	}
	for _, id := range []int64{threadID, postID} {
		id := id
		if _, _, err := f.msgs.SearchMessages(bg(), thrOther, SearchRequest{Query: "needle", ChannelID: &id}); !errors.Is(err, ErrForbidden) {
			t.Errorf("thread-scoped search of %d: err = %v, want ErrForbidden", id, err)
		}
	}
	if got := searchedChannels(t, f, thrMod, SearchRequest{Query: "needle"}); !got[threadID] || !got[postID] {
		t.Fatalf("moderator channels = %v, want both", got)
	}
}

// An NSFW parent the member has not acknowledged hides its threads too; acknowledging reveals them.
func TestSearchMessages_ThreadOfUnacknowledgedNSFWParentHidden(t *testing.T) {
	f := newForumPostFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: srchNSFWParent, Name: "spicy", Type: "text"})
	if _, err := f.database.ExecContext(bg(), `UPDATE channels SET nsfw = 1 WHERE id = ?`, srchNSFWParent); err != nil {
		t.Fatal(err)
	}
	starter := f.post(t, srchNSFWParent, thrOwner, "s")
	info, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: srchNSFWParent, MessageID: starter, Name: "n"})
	mustDo(t, "Create", err)
	f.post(t, info.ID, thrOwner, "needle in nsfw thread")

	if got := searchedChannels(t, f, thrOther, SearchRequest{Query: "needle"}); got[info.ID] {
		t.Fatalf("unacknowledged: channels = %v, want the thread hidden", got)
	}
	id := info.ID
	if _, _, err := f.msgs.SearchMessages(bg(), thrOther, SearchRequest{Query: "needle", ChannelID: &id}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("thread-scoped search of an unacknowledged NSFW thread: err = %v, want ErrForbidden", err)
	}
	if _, err := f.database.AcknowledgeNSFW(bg(), thrOther, srchNSFWParent); err != nil {
		t.Fatal(err)
	}
	if got := searchedChannels(t, f, thrOther, SearchRequest{Query: "needle"}); !got[info.ID] {
		t.Fatalf("acknowledged: channels = %v, want the thread", got)
	}
	if got := searchedChannels(t, f, thrOther, SearchRequest{Query: "needle", ChannelID: &id}); !got[info.ID] {
		t.Fatalf("acknowledged, thread-scoped: channels = %v, want the thread", got)
	}
}
