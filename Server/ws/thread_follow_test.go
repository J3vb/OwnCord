package ws

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// followFixture is the activity fixture plus one thread under its text channel,
// started by the fixture's author (who therefore follows it).
type followFixture struct {
	*activityFixture
	thread int64
	deps   ThreadDeps
}

func newFollowFixture(t *testing.T) *followFixture {
	t.Helper()
	af := newActivityFixture(t)
	ctx := context.Background()
	starter, err := af.db.CreateMessage(ctx, af.textID, af.author.ID, "start here", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	info, _, err := af.db.CreateThread(ctx, db.NewThread{
		ParentID: af.textID, StarterMessageID: starter, OwnerID: af.author.ID, Name: "t", AutoArchiveMinutes: 1440,
	})
	if err != nil {
		t.Fatalf("CreateThread: %v", err)
	}
	// The fixture's hub is never Run or Stopped, so its coalescer timers would
	// outlive the test and read threadChangedInterval while another test sets it.
	t.Cleanup(af.hub.stopThreadFeed)
	return &followFixture{
		activityFixture: af, thread: info.ID,
		deps: ThreadDeps{Limiter: af.hub.limiter, ThreadSvc: af.svc.Threads, ChannelSvc: af.svc.Channels},
	}
}

func (f *followFixture) follow(uid int64, follow bool) Result {
	return handleThreadFollowV2(context.Background(), ThreadFollowCmd{userID: uid, ThreadID: f.thread, Follow: follow},
		ClientInfo{UserID: uid, ReqID: "r"}, f.deps)
}

func (f *followFixture) followers(t *testing.T) []int64 {
	t.Helper()
	ids, err := f.db.ListThreadFollowers(context.Background(), f.thread)
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

type followUpdate struct {
	ThreadID  int64          `json:"thread_id"`
	Following bool           `json:"following"`
	Thread    *db.ThreadInfo `json:"thread"`
}

// followUpdates drains ch and returns every thread_follow_update it holds.
func followUpdates(ch chan []byte) []followUpdate { return followUpdatesFor(ch, 80*time.Millisecond) }

func followUpdatesFor(ch chan []byte, d time.Duration) []followUpdate {
	var out []followUpdate
	for _, m := range drainChan(ch, d) {
		var env struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil || env.Type != MsgTypeThreadFollowUpdate {
			continue
		}
		var u followUpdate
		if json.Unmarshal(env.Payload, &u) == nil {
			out = append(out, u)
		}
	}
	return out
}

func TestParseThreadFollow(t *testing.T) {
	cmd, err := parseThread(t, MsgTypeThreadFollow, `{"thread_id":6,"follow":false}`)
	if c, ok := cmd.(ThreadFollowCmd); err != nil || !ok || c.ThreadID != 6 || c.Follow || c.UserID() != 7 || c.Type() != MsgTypeThreadFollow {
		t.Errorf("follow = %#v, %v", cmd, err)
	}
	for _, p := range []string{`not json`, `{"follow":true}`, `{"thread_id":0,"follow":true}`, `{"thread_id":3}`, `{"thread_id":3,"follow":"yes"}`} {
		if cmd, err := parseThread(t, MsgTypeThreadFollow, p); err == nil {
			t.Errorf("%s parsed to %#v, want an error", p, cmd)
		}
	}
}

func TestHandleThreadFollow_OkIdempotentAndRefusedWhenInvisible(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	reader := f.user(t, "reader", permissions.MemberRoleID)
	denied := f.user(t, "denied", permissions.MemberRoleID)
	readerSend := f.connect(reader, 0)
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, denied.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()

	for i := range 2 { // idempotent: the second follow answers the same
		res := f.follow(reader.ID, true)
		if res.Error != nil {
			t.Fatalf("follow #%d = %+v", i+1, res)
		}
		var ok struct {
			Type    string `json:"type"`
			ID      string `json:"id"`
			Payload struct {
				ThreadID  int64 `json:"thread_id"`
				Following bool  `json:"following"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(res.Reply, &ok); err != nil || ok.Type != MsgTypeThreadFollowOK || ok.ID != "r" ||
			ok.Payload.ThreadID != f.thread || !ok.Payload.Following {
			t.Fatalf("reply = %s (%v)", res.Reply, err)
		}
		f.hub.EmitEvents(ctx, res.Events)
	}
	got := followUpdates(readerSend)
	if len(got) != 2 || !got[0].Following || got[0].ThreadID != f.thread || got[0].Thread == nil || got[0].Thread.ID != f.thread {
		t.Fatalf("updates = %+v, want two following:true with the thread", got)
	}
	if !slices.Contains(f.followers(t), reader.ID) {
		t.Fatalf("followers = %v, want the reader", f.followers(t))
	}

	for range 2 {
		res := f.follow(reader.ID, false)
		if res.Error != nil {
			t.Fatalf("unfollow = %+v", res)
		}
		f.hub.EmitEvents(ctx, res.Events)
	}
	got = followUpdates(readerSend)
	if len(got) != 2 || got[0].Following || got[0].Thread != nil {
		t.Fatalf("unfollow updates = %+v, want following:false with no thread", got)
	}
	if slices.Contains(f.followers(t), reader.ID) {
		t.Fatalf("followers = %v, the reader unfollowed", f.followers(t))
	}

	// An invisible thread is not found, and nothing is written.
	wantCode(t, "invisible thread", f.follow(denied.ID, true), ErrCodeNotFound)
	if slices.Contains(f.followers(t), denied.ID) {
		t.Fatal("a user who cannot see the parent was made a follower")
	}
	wantCode(t, "not a thread", handleThreadFollowV2(ctx, ThreadFollowCmd{userID: reader.ID, ThreadID: f.textID, Follow: true},
		ClientInfo{UserID: reader.ID}, f.deps), ErrCodeNotFound)
	wantCode(t, "no thread service", handleThreadFollowV2(ctx, ThreadFollowCmd{userID: reader.ID, ThreadID: f.thread, Follow: true},
		ClientInfo{UserID: reader.ID}, ThreadDeps{}), ErrCodeInternal)
}

// Edge case 1: follow, post (rejoins after an unfollow), unfollow. Whichever
// write came last decides the table, and the last frame the user got says the
// same.
func TestThreadFollow_LastWriteWinsAcrossAutoJoinAndUnfollow(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	reader := f.user(t, "reader", permissions.MemberRoleID)
	send := f.connect(reader, 0)

	state := func(step string, want bool) {
		t.Helper()
		if got := slices.Contains(f.followers(t), reader.ID); got != want {
			t.Fatalf("%s: table says following=%v, want %v", step, got, want)
		}
		ups := followUpdates(send)
		if len(ups) == 0 || ups[len(ups)-1].Following != want {
			t.Fatalf("%s: frames %+v, want the last to say following=%v", step, ups, want)
		}
	}
	emit := func(res Result) {
		t.Helper()
		if res.Error != nil {
			t.Fatalf("result = %+v", res)
		}
		f.hub.EmitEvents(ctx, res.Events)
	}

	emit(f.follow(reader.ID, true))
	state("follow", true)
	emit(f.follow(reader.ID, false))
	state("unfollow", false)

	// Posting follows again; the flush the post raises tells the new follower.
	res, _ := f.send(t, reader, f.thread, "back again")
	f.hub.EmitEvents(ctx, res.Events)
	state("post", true)

	emit(f.follow(reader.ID, false))
	state("final unfollow", false)
}

func TestThreadAutoJoin_DirectMentionFollowsEveryoneDoesNot(t *testing.T) {
	f := newFollowFixture(t)
	mentioned := f.user(t, "mentioned", permissions.MemberRoleID)
	bystander := f.user(t, "bystander", permissions.MemberRoleID)
	mSend := f.connect(mentioned, 0)
	bSend := f.connect(bystander, 0)

	res, _ := f.send(t, f.author, f.thread, "hello @mentioned")
	f.hub.EmitEvents(context.Background(), res.Events)
	if ups := followUpdates(mSend); len(ups) == 0 || !ups[0].Following || ups[0].Thread == nil {
		t.Fatalf("mentioned user frames = %+v, want a following:true update with the thread", ups)
	}
	res, _ = f.send(t, f.author, f.thread, "hello @everyone")
	f.hub.EmitEvents(context.Background(), res.Events)
	if ups := followUpdates(bSend); len(ups) != 0 {
		t.Fatalf("bystander frames = %+v, want none", ups)
	}
	if got := f.followers(t); !slices.Contains(got, mentioned.ID) || slices.Contains(got, bystander.ID) {
		t.Fatalf("followers = %v, want the author and the mentioned user only", got)
	}
}

func readyThreadsOf(t *testing.T, f *followFixture, uid int64) []struct {
	Thread            db.ThreadInfo `json:"thread"`
	LastMessageID     int64         `json:"last_message_id"`
	LastReadMessageID int64         `json:"last_read_message_id"`
	UnreadCount       int64         `json:"unread_count"`
	MentionCount      int64         `json:"mention_count"`
} {
	t.Helper()
	held, err := f.db.GetMemberRoles(context.Background(), uid)
	if err != nil || held == nil {
		t.Fatalf("GetMemberRoles: %v", err)
	}
	raw, err := f.hub.readyBytes(f.db, uid, held.Effective())
	if err != nil {
		t.Fatalf("ready: %v", err)
	}
	var env struct {
		Payload struct {
			Threads *[]struct {
				Thread            db.ThreadInfo `json:"thread"`
				LastMessageID     int64         `json:"last_message_id"`
				LastReadMessageID int64         `json:"last_read_message_id"`
				UnreadCount       int64         `json:"unread_count"`
				MentionCount      int64         `json:"mention_count"`
			} `json:"threads"`
			Capabilities map[string]any `json:"capabilities"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.Capabilities["thread_follows"] != true {
		t.Fatalf("capabilities = %v, want thread_follows", env.Payload.Capabilities)
	}
	if env.Payload.Threads == nil {
		t.Fatal("ready has no threads key")
	}
	return *env.Payload.Threads
}

func TestReadyThreads_FollowedOpenWithCountsParentGated(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	reader := f.user(t, "reader", permissions.MemberRoleID)
	if res := f.follow(reader.ID, true); res.Error != nil {
		t.Fatal(res.Error)
	}
	// Two messages by the author, the second mentioning the reader.
	f.send(t, f.author, f.thread, "one")
	f.send(t, f.author, f.thread, "two @reader")

	got := readyThreadsOf(t, f, reader.ID)
	if len(got) != 1 || got[0].Thread.ID != f.thread || got[0].Thread.ParentID != f.textID {
		t.Fatalf("ready.threads = %+v, want the one followed thread", got)
	}
	g := got[0]
	if g.UnreadCount != 2 || g.LastMessageID == 0 || g.LastReadMessageID != 0 {
		t.Fatalf("counts = %+v, want 2 unread, a last message, nothing read", g)
	}
	// "two @reader" auto-joined nobody new (already a follower) and raised a mention.
	if g.MentionCount != 1 {
		t.Fatalf("mention_count = %d, want 1", g.MentionCount)
	}

	// A thread nobody follows is not listed, and an empty list is [] not absent.
	other := f.user(t, "other", permissions.MemberRoleID)
	if got := readyThreadsOf(t, f, other.ID); len(got) != 0 {
		t.Fatalf("a non-follower's ready.threads = %+v", got)
	}

	// Edge case 2: the follower loses READ on the parent by override. The
	// thread leaves ready, the row stays, and READ restored brings it back.
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, reader.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	if got := readyThreadsOf(t, f, reader.ID); len(got) != 0 {
		t.Fatalf("ready.threads = %+v after the parent denied READ, want none", got)
	}
	if !slices.Contains(f.followers(t), reader.ID) {
		t.Fatal("the follow row must survive losing the parent")
	}
	if err := f.db.DeleteChannelUserOverride(ctx, f.textID, reader.ID); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	if got := readyThreadsOf(t, f, reader.ID); len(got) != 1 || got[0].Thread.ID != f.thread {
		t.Fatalf("ready.threads = %+v after READ was restored, want the thread back", got)
	}

	// An archived thread leaves the list.
	if _, err := f.db.ExecContext(ctx, `UPDATE channels SET thread_archived = 1 WHERE id = ?`, f.thread); err != nil {
		t.Fatal(err)
	}
	if got := readyThreadsOf(t, f, reader.ID); len(got) != 0 {
		t.Fatalf("ready.threads = %+v for an archived thread, want none", got)
	}
}

func TestChannelActivity_ThreadMessageReachesFollowersOnly(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	follower := f.user(t, "follower", permissions.MemberRoleID)
	nonFollower := f.user(t, "nonfollower", permissions.MemberRoleID)
	lost := f.user(t, "lost", permissions.MemberRoleID)
	for _, u := range []*db.User{follower, lost} {
		if res := f.follow(u.ID, true); res.Error != nil {
			t.Fatal(res.Error)
		}
	}
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, lost.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()

	followerSend := f.connect(follower, 0)
	nonSend := f.connect(nonFollower, 0)
	lostSend := f.connect(lost, 0)

	f.send(t, f.author, f.thread, "in the thread")
	f.flush()

	e := wantOneEntry(t, "follower", activityFrames(followerSend))
	if e.ChannelID != f.thread {
		t.Fatalf("follower entry = %+v, want thread %d", e, f.thread)
	}
	if got := activityFrames(nonSend); len(got) != 0 {
		t.Errorf("a non-follower received %+v, want nothing", got)
	}
	if got := activityFrames(lostSend); len(got) != 0 {
		t.Errorf("a follower who lost the parent received %+v, want nothing (a row is never permission)", got)
	}

	// READ restored: the kept follow row brings the hint back.
	if err := f.db.DeleteChannelUserOverride(ctx, f.textID, lost.ID); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	_, msgID := f.send(t, f.author, f.thread, "after the restore")
	f.flush()
	if e := wantOneEntry(t, "restored follower", activityFrames(lostSend)); e.ChannelID != f.thread || e.MessageID != msgID {
		t.Fatalf("restored follower entry = %+v, want thread %d message %d", e, f.thread, msgID)
	}
}

func TestThreadCoalescer_FlushSendsFollowUpdateToFollowers(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	follower := f.user(t, "follower", permissions.MemberRoleID)
	lost := f.user(t, "lost", permissions.MemberRoleID)
	bystander := f.user(t, "bystander", permissions.MemberRoleID)
	for _, u := range []*db.User{follower, lost} {
		if res := f.follow(u.ID, true); res.Error != nil {
			t.Fatal(res.Error)
		}
	}
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, lost.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	followerSend := f.connect(follower, 0)
	lostSend := f.connect(lost, 0)
	bySend := f.connect(bystander, 0)

	name := "renamed"
	res := handleThreadUpdateV2(ctx, ThreadUpdateCmd{userID: f.author.ID, ThreadID: f.thread, Name: &name},
		ClientInfo{UserID: f.author.ID}, f.deps)
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	f.hub.EmitEvents(ctx, res.Events)

	ups := followUpdates(followerSend)
	if len(ups) == 0 || !ups[0].Following || ups[0].Thread == nil || ups[0].Thread.Name != "renamed" {
		t.Fatalf("follower updates = %+v, want following:true with the renamed thread", ups)
	}
	for who, ch := range map[string]chan []byte{"lost": lostSend, "bystander": bySend} {
		if got := followUpdates(ch); len(got) != 0 {
			t.Errorf("%s received %+v, want nothing", who, got)
		}
	}
}

func TestHandleThreadDelete_TellsFollowersFollowingFalse(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	follower := f.user(t, "follower", permissions.MemberRoleID)
	mod := f.user(t, "moddy", permissions.ModeratorRoleID)
	if res := f.follow(follower.ID, true); res.Error != nil {
		t.Fatal(res.Error)
	}
	followerSend := f.connect(follower, 0)

	res := handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: mod.ID, ThreadID: f.thread}, ClientInfo{UserID: mod.ID}, f.deps)
	if res.Error != nil {
		t.Fatalf("delete = %+v", res)
	}
	targets := map[int64]bool{}
	for _, ev := range res.Events {
		if fe, ok := ev.(threadFollowEvt); ok {
			targets[fe.targetUserID] = true
		}
	}
	if !targets[follower.ID] || !targets[f.author.ID] {
		t.Fatalf("follow events target %v, want every follower (the owner and the follower)", targets)
	}
	f.hub.EmitEvents(ctx, res.Events)
	ups := followUpdates(followerSend)
	if len(ups) != 1 || ups[0].Following || ups[0].Thread != nil || ups[0].ThreadID != f.thread {
		t.Fatalf("follower updates = %+v, want one following:false without a thread", ups)
	}
	if n := len(f.followers(t)); n != 0 {
		t.Fatalf("%d followers left after the thread went", n)
	}
}

func TestThreadService_FollowWithoutStorageAnswersInternal(t *testing.T) {
	svc := &service.ThreadService{}
	if _, err := svc.Followers(context.Background(), 1); !errors.Is(err, service.ErrInternal) {
		t.Fatalf("Followers = %v, want ErrInternal", err)
	}
	if _, err := svc.SetFollow(context.Background(), 1, 1, true); !errors.Is(err, service.ErrInternal) {
		t.Fatalf("SetFollow = %v, want ErrInternal", err)
	}
}

// A thread's name discloses its starter message, so an NSFW parent hides its
// threads from a member who has not acknowledged it: they cannot follow, no
// frame names the thread to them, and ready.threads leaves it out until they do.
func TestThreadFollow_NSFWParentNeedsAcknowledgement(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	member := f.user(t, "member", permissions.MemberRoleID)
	send := f.connect(member, 0)
	if _, err := f.db.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.textID); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()

	wantCode(t, "unacknowledged NSFW parent", f.follow(member.ID, true), ErrCodeForbidden)
	if slices.Contains(f.followers(t), member.ID) {
		t.Fatal("a follower row was written for an unacknowledged member")
	}

	// A follow that predates the label: it stays, and nothing names the thread.
	if _, err := f.db.FollowThread(ctx, f.thread, member.ID); err != nil {
		t.Fatal(err)
	}
	if got := readyThreadsOf(t, f, member.ID); len(got) != 0 {
		t.Fatalf("ready.threads = %+v before the acknowledgement, want none", got)
	}
	f.hub.ThreadChanged(f.thread)
	if got := followUpdates(send); len(got) != 0 {
		t.Fatalf("follow updates = %+v before the acknowledgement, want none", got)
	}

	if _, err := f.db.ExecContext(ctx, `INSERT INTO nsfw_acknowledgements (user_id, channel_id) VALUES (?, ?)`, member.ID, f.textID); err != nil {
		t.Fatal(err)
	}
	if got := readyThreadsOf(t, f, member.ID); len(got) != 1 {
		t.Fatalf("ready.threads = %+v after the acknowledgement, want the thread", got)
	}
}

// raceFlush runs one thread_changed flush with inside() landing between the
// audience read and the send, and returns what reader was sent.
func raceFlush(t *testing.T, f *followFixture, reader *db.User, inside func()) []followUpdate {
	t.Helper()
	send := f.connect(reader, 0)
	reached := make(chan struct{})
	var once sync.Once
	threadFollowBeforeSendHook = func() {
		once.Do(func() { inside(); close(reached) })
	}
	t.Cleanup(func() { threadFollowBeforeSendHook = nil })
	f.hub.noteThreadChanged(f.thread)
	select {
	case <-reached:
	case <-time.After(5 * time.Second):
		t.Fatal("the flush never reached the send step")
	}
	return followUpdatesFor(send, 400*time.Millisecond)
}

func wantNoTrueAfterFalse(t *testing.T, ups []followUpdate) {
	t.Helper()
	sawFalse := false
	for _, u := range ups {
		if !u.Following {
			sawFalse = true
		} else if sawFalse {
			t.Fatalf("frames %+v: a following:true came after following:false", ups)
		}
	}
	if !sawFalse {
		t.Fatalf("frames %+v: want the following:false to arrive", ups)
	}
}

func TestThreadFollowFlush_UnfollowInsideTheWindowIsNotOverwritten(t *testing.T) {
	f := newFollowFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	if res := f.follow(reader.ID, true); res.Error != nil {
		t.Fatal(res.Error)
	}
	ups := raceFlush(t, f, reader, func() {
		res := f.follow(reader.ID, false)
		f.hub.EmitEvents(context.Background(), res.Events)
	})
	wantNoTrueAfterFalse(t, ups)
	if ups[len(ups)-1].Following {
		t.Fatalf("last frame %+v, want following:false", ups[len(ups)-1])
	}
}

func TestThreadFollowFlush_DeleteInsideTheWindowSendsNoTrueAfterFalse(t *testing.T) {
	f := newFollowFixture(t)
	ctx := context.Background()
	reader := f.user(t, "reader", permissions.MemberRoleID)
	mod := f.user(t, "moddy", permissions.ModeratorRoleID)
	if res := f.follow(reader.ID, true); res.Error != nil {
		t.Fatal(res.Error)
	}
	ups := raceFlush(t, f, reader, func() {
		res := handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: mod.ID, ThreadID: f.thread}, ClientInfo{UserID: mod.ID}, f.deps)
		if res.Error != nil {
			t.Errorf("delete = %+v", res)
			return
		}
		for _, ev := range res.Events {
			switch ev.(type) {
			case threadNoteEvt, threadFollowEvt: // the sequenced thread_deleted needs a running hub
				f.hub.EmitEvents(ctx, []Event{ev})
			}
		}
	})
	wantNoTrueAfterFalse(t, ups)
}

// A forum post's follow update goes only to followers whose socket declared
// forums, as every other frame about a post does.
func TestThreadFollowFlush_ForumPostSkipsClientsWithoutForums(t *testing.T) {
	e := newForumPostEnv(t)
	ctx := context.Background()
	t.Cleanup(e.hub.stopThreadFeed)
	_, newSend := e.connectWith(t, "newer", true)
	_, oldSend := e.connectWith(t, "older", false)
	res := e.create(newCMID(), "Hello", "hello post")
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	var ok okFrame
	if err := json.Unmarshal(res.Reply, &ok); err != nil {
		t.Fatal(err)
	}
	post := ok.Payload.Thread.ID
	deps := ThreadDeps{Limiter: e.hub.limiter, ThreadSvc: e.svc.Threads, ChannelSvc: e.svc.Channels}
	for _, name := range []string{"newer", "older"} {
		uid := e.connectedID(t, name)
		if r := handleThreadFollowV2(ctx, ThreadFollowCmd{userID: uid, ThreadID: post, Follow: true},
			ClientInfo{UserID: uid, ReqID: "r"}, deps); r.Error != nil {
			t.Fatalf("%s follow: %v", name, r.Error)
		}
	}
	drainFor(newSend, 100*time.Millisecond)
	drainFor(oldSend, 100*time.Millisecond)

	name := "renamed post"
	upd := handleThreadUpdateV2(ctx, ThreadUpdateCmd{userID: e.poster.ID, ThreadID: post, Name: &name},
		ClientInfo{UserID: e.poster.ID}, deps)
	if upd.Error != nil {
		t.Fatal(upd.Error)
	}
	e.hub.EmitEvents(ctx, upd.Events)
	if got := followUpdates(newSend); len(got) == 0 || !got[0].Following {
		t.Fatalf("forums follower updates = %+v, want following:true", got)
	}
	if got := followUpdates(oldSend); len(got) != 0 {
		t.Fatalf("a client without forums was sent a post's follow update: %+v", got)
	}
}
