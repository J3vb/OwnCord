package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

func TestParseForumPostCreate(t *testing.T) {
	cmd, err := parseThread(t, MsgTypeForumPostCreate,
		`{"client_message_id":"c","channel_id":3,"name":"Title","content":"body","attachments":["a","b"],"tag_ids":[2,1]}`)
	if err != nil {
		t.Fatal(err)
	}
	c, ok := cmd.(ForumPostCreateCmd)
	if !ok || c.ChannelID != 3 || c.Name != "Title" || c.Content != "body" || c.ClientMessageID != "c" ||
		len(c.Attachments()) != 2 || len(c.TagIDs) != 2 || c.UserID() != 7 || c.Type() != MsgTypeForumPostCreate {
		t.Fatalf("cmd = %#v", cmd)
	}
	if cmd, err = parseThread(t, MsgTypeForumPostCreate, `{"client_message_id":"c","channel_id":3,"name":"n"}`); err != nil || len(cmd.(ForumPostCreateCmd).TagIDs) != 0 {
		t.Fatalf("minimal = %#v, %v", cmd, err)
	}
	many := make([]string, 11)
	tags := make([]string, maxForumPostTagIDs+1)
	for i := range tags {
		tags[i] = "1"
	}
	for _, p := range []string{
		`not json`, `{"channel_id":3,"name":"n"}`, `{"client_message_id":"c","name":"n"}`,
		`{"client_message_id":"c","channel_id":0,"name":"n"}`, `{"client_message_id":"c","channel_id":"x","name":"n"}`,
		`{"client_message_id":"c","channel_id":1.5,"name":"n"}`, `{"client_message_id":"c","channel_id":3,"tag_ids":"x"}`,
		fmt.Sprintf(`{"client_message_id":"c","channel_id":3,"attachments":%q}`, many),
		`{"client_message_id":"c","channel_id":3,"attachments":["` + strings.Repeat("a", 2049) + `"]}`,
		`{"client_message_id":"c","channel_id":3,"tag_ids":[` + strings.Join(tags, ",") + `]}`,
	} {
		if cmd, err := parseThread(t, MsgTypeForumPostCreate, p); err == nil {
			t.Errorf("%.60s parsed to %#v, want an error", p, cmd)
		}
	}
	// thread_update carries tag_ids: absent leaves them, [] clears.
	u, err := parseThread(t, MsgTypeThreadUpdate, `{"thread_id":4,"tag_ids":[]}`)
	if err != nil || u.(ThreadUpdateCmd).TagIDs == nil || len(*u.(ThreadUpdateCmd).TagIDs) != 0 {
		t.Fatalf("update with empty tag_ids = %#v, %v", u, err)
	}
	if u, err = parseThread(t, MsgTypeThreadUpdate, `{"thread_id":4,"name":"x"}`); err != nil || u.(ThreadUpdateCmd).TagIDs != nil {
		t.Fatalf("update without tag_ids = %#v, %v", u, err)
	}
	if _, err = parseThread(t, MsgTypeThreadUpdate, `{"thread_id":4,"tag_ids":[`+strings.Join(tags, ",")+`]}`); err == nil {
		t.Fatal("an update with a hostile tag list parsed")
	}
}

// forumPostEnv is the thread fixture plus a forum with two tags, a poster and
// the three kinds of listener: one that declared the forums feature, one that
// did not, and (per test) the poster's own session.
type forumPostEnv struct {
	*threadWSFixture
	forum  int64
	tags   []db.ForumTag
	poster *db.User
	deps   ChatDeps
}

func newForumPostEnv(t *testing.T) *forumPostEnv {
	t.Helper()
	f := newThreadWSFixture(t)
	ctx := context.Background()
	forum, err := f.database.CreateChannel(ctx, "ideas", "forum", "", "", 5)
	if err != nil {
		t.Fatal(err)
	}
	tags, err := f.database.ReplaceForumSettings(ctx, forum, db.ForumSettingsWrite{
		DefaultAutoArchiveMinutes: 1440, Tags: []db.ForumTagWrite{{Name: "bug"}, {Name: "idea"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	pid, err := f.database.CreateUser(ctx, "poster", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatal(err)
	}
	poster, err := f.database.GetUserByID(ctx, pid)
	if err != nil || poster == nil {
		t.Fatal(err)
	}
	old := threadChangedInterval
	threadChangedInterval = 40 * time.Millisecond
	t.Cleanup(func() { threadChangedInterval = old })
	return &forumPostEnv{
		threadWSFixture: f, forum: forum, tags: tags, poster: poster,
		deps: ChatDeps{Limiter: f.hub.limiter, MessageSvc: f.svc.Messages, LiveStatus: f.hub.LiveStatus},
	}
}

func (e *forumPostEnv) create(cmid, title, content string, tagIDs ...int64) Result {
	return handleForumPostCreateV2(context.Background(),
		ForumPostCreateCmd{userID: e.poster.ID, ClientMessageID: cmid, ChannelID: e.forum, Name: title, Content: content, TagIDs: tagIDs},
		ClientInfo{UserID: e.poster.ID, Username: e.poster.Username, ReqID: "req-1", RoleName: "member"}, e.deps)
}

func newCMID() string { return fmt.Sprintf("%d:%s", time.Now().UnixMilli(), uuid.NewString()) }

// connectWith registers a live client for a fresh user with the given features.
func (e *forumPostEnv) connectWith(t *testing.T, name string, forums bool) (*Client, chan []byte) {
	t.Helper()
	c, send := e.connect(t, name)
	c.features = clientFeatures{forums: forums}
	return c, send
}

type okFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Payload struct {
		Thread struct {
			ID       int64  `json:"id"`
			ParentID int64  `json:"parent_id"`
			Name     string `json:"name"`
			Post     struct {
				TagIDs       []int64 `json:"tag_ids"`
				FirstMessage struct {
					ID      int64  `json:"id"`
					Preview string `json:"preview"`
				} `json:"first_message"`
			} `json:"post"`
		} `json:"thread"`
		MessageID       int64  `json:"message_id"`
		ClientMessageID string `json:"client_message_id"`
		Deduplicated    bool   `json:"deduplicated"`
	} `json:"payload"`
}

func TestHandleForumPostCreate_ReplyEventsAndRetry(t *testing.T) {
	e := newForumPostEnv(t)
	cmid := newCMID()
	res := e.create(cmid, "  Dark mode ", "please add it", e.tags[1].ID)
	if res.Error != nil {
		t.Fatalf("create: %v", res.Error)
	}
	var ok okFrame
	if err := json.Unmarshal(res.Reply, &ok); err != nil {
		t.Fatal(err)
	}
	p := ok.Payload
	if ok.Type != MsgTypeForumPostCreateOK || ok.ID != "req-1" || p.Deduplicated || p.ClientMessageID != cmid ||
		p.Thread.Name != "Dark mode" || p.Thread.ParentID != e.forum || p.MessageID != p.Thread.Post.FirstMessage.ID ||
		p.Thread.Post.FirstMessage.Preview != "please add it" || len(p.Thread.Post.TagIDs) != 1 {
		t.Fatalf("reply = %s", res.Reply)
	}
	var chat, note, activity int
	for _, ev := range res.Events {
		switch v := ev.(type) {
		case channelEvt:
			if v.evType == MsgTypeChatMessage && v.channelID == p.Thread.ID {
				chat++
			}
		case threadNoteEvt:
			if v.threadID == p.Thread.ID {
				note++
			}
		case channelActivityEvt:
			if v.channelID == p.Thread.ID {
				activity++
			}
		}
	}
	if chat != 1 || note != 1 || activity != 1 || len(res.Events) != 3 {
		t.Fatalf("events = %+v, want one chat_message, one thread note and one activity note on the post", res.Events)
	}

	// The lost-ack retry: the same post, deduplicated, and nothing announced.
	again := e.create(cmid, "  Dark mode ", "please add it", e.tags[1].ID)
	var ok2 okFrame
	if err := json.Unmarshal(again.Reply, &ok2); err != nil || again.Error != nil || len(again.Events) != 0 {
		t.Fatalf("retry = %+v, %v", again, err)
	}
	if !ok2.Payload.Deduplicated || ok2.Payload.Thread.ID != p.Thread.ID || ok2.Payload.MessageID != p.MessageID {
		t.Fatalf("retry reply = %s", again.Reply)
	}

	wantCode(t, "changed payload", e.create(cmid, "other", "please add it", e.tags[1].ID), ErrCodeConflict)
	wantCode(t, "empty title", e.create(newCMID(), " ", "x"), ErrCodeBadRequest)
	wantCode(t, "unknown tag", e.create(newCMID(), "t", "x", 9999), ErrCodeBadRequest)
	wantCode(t, "bad id", e.create("nope", "t", "x"), ErrCodeBadRequest)
	// A moderator deletes the post: its retry answers ALREADY_DELETED.
	if _, err := e.svc.Threads.Delete(context.Background(), e.owner(t), p.Thread.ID); err != nil {
		t.Fatal(err)
	}
	wantCode(t, "retry after delete", e.create(cmid, "  Dark mode ", "please add it", e.tags[1].ID), ErrCodeAlreadyDeleted)
}

// owner returns an Owner-role user for moderator-level actions.
func (e *forumPostEnv) owner(t *testing.T) int64 {
	t.Helper()
	id, err := e.database.CreateUser(context.Background(), "ownr", "hash", int(permissions.OwnerRoleID))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// frameOfType finds the first frame of typ and decodes its thread block.
func threadChangedFrames(frames [][]byte) []okFrame {
	var out []okFrame
	for _, f := range frames {
		var fr okFrame
		if json.Unmarshal(f, &fr) == nil && fr.Type == MsgTypeThreadChanged {
			out = append(out, fr)
		}
	}
	return out
}

// A forum-focused socket hears the new post (thread_changed with the preview)
// and then an edit of the opening message. A socket that did not declare the
// feature cannot hold the forum, and a post's topic is refused it too.
func TestForumPostFrames_ReachOnlyForumsClients(t *testing.T) {
	e := newForumPostEnv(t)
	ctx := context.Background()
	newC, newSend := e.connectWith(t, "newer", true)
	oldC, oldSend := e.connectWith(t, "older", false)
	e.hub.applySetChannelID(newC, e.forum)
	e.hub.applySetChannelID(oldC, e.forum)
	if newC.getChannelID() != e.forum || oldC.getChannelID() != 0 {
		t.Fatalf("forum focus: new=%d old=%d, want the forum and 0", newC.getChannelID(), oldC.getChannelID())
	}

	res := e.create(newCMID(), "Dark mode", "please add it")
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	var ok okFrame
	_ = json.Unmarshal(res.Reply, &ok)
	post := ok.Payload.Thread.ID
	e.hub.EmitEvents(ctx, res.Events)

	// The post's own topic: refused to the old client, held by the new one.
	e.hub.applyThreadFocus(newC, post)
	e.hub.applyThreadFocus(oldC, post)
	if newC.getThreadID() != post || oldC.getThreadID() != 0 {
		t.Fatalf("post focus: new=%d old=%d, want the post and 0", newC.getThreadID(), oldC.getThreadID())
	}
	newSeen := drainFor(newSend, 400*time.Millisecond)
	changed := threadChangedFrames(newSeen)
	if len(changed) != 1 || changed[0].Payload.Thread.Post.FirstMessage.Preview != "please add it" {
		t.Fatalf("forum viewer saw %d thread_changed: %q", len(changed), newSeen)
	}
	if got := drainFor(oldSend, 100*time.Millisecond); countType(got, MsgTypeThreadChanged)+countType(got, MsgTypeChatMessage) != 0 {
		t.Fatalf("a client without the forums feature got post frames: %q", got)
	}

	// Editing the opening message tells the forum's viewers.
	edit := handleChatEditV2(ctx, ChatEditCmd{userID: e.poster.ID, MessageID: ok.Payload.MessageID, Content: "edited text"},
		ClientInfo{UserID: e.poster.ID}, e.deps)
	if edit.Error != nil {
		t.Fatal(edit.Error)
	}
	e.hub.EmitEvents(ctx, edit.Events)
	frames := drainFor(newSend, 400*time.Millisecond)
	changed = threadChangedFrames(frames)
	if len(changed) != 1 || changed[0].Payload.Thread.Post.FirstMessage.Preview != "edited text" || countType(frames, MsgTypeChatEdited) != 1 {
		t.Fatalf("after an edit of the opening message the forum viewer saw %q", frames)
	}

	// An edit of a reply is not a preview change: no thread_changed.
	reply := e.svc.Messages
	rid, err := reply.SendMessage(ctx, service.SendMessageParams{ChannelID: post, UserID: e.poster.ID, Username: "poster", Content: "a reply"})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * threadChangedInterval)
	drainFor(newSend, 100*time.Millisecond)
	edit = handleChatEditV2(ctx, ChatEditCmd{userID: e.poster.ID, MessageID: rid.MessageID, Content: "reply edited"},
		ClientInfo{UserID: e.poster.ID}, e.deps)
	e.hub.EmitEvents(ctx, edit.Events)
	if got := drainFor(newSend, 300*time.Millisecond); countType(got, MsgTypeThreadChanged) != 0 {
		t.Fatalf("an edit of a reply produced a thread_changed: %q", got)
	}
}

// The targeted frames that do not ride a topic follow the same rule: the unread
// hint (channel_activity) and the mention badge (mention_count) of a post go to
// clients that know forums.
func TestForumPostHintsAndBadges_SkipClientsWithoutForums(t *testing.T) {
	e := newForumPostEnv(t)
	ctx := context.Background()
	_, newSend := e.connectWith(t, "newer", true)
	_, oldSend := e.connectWith(t, "older", false)
	res := e.create(newCMID(), "Hello", "hello post")
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	var ok okFrame
	_ = json.Unmarshal(res.Reply, &ok)
	for _, ev := range res.Events {
		if _, isNote := ev.(ActivityEvent); isNote {
			e.hub.EmitEvents(ctx, []Event{ev})
		}
	}
	e.hub.flushChannelActivity(ctx)
	if got := activityFrames(newSend); len(got) != 1 || len(got[0]) != 1 || got[0][0].ChannelID != ok.Payload.Thread.ID {
		t.Fatalf("a forums client's activity hint = %+v, want the post", got)
	}
	if got := activityFrames(oldSend); len(got) != 0 {
		t.Fatalf("a client without forums was sent a hint for a post: %+v", got)
	}

	e.hub.NotifyMentionCount(e.connectedID(t, "newer"), ok.Payload.Thread.ID, 2)
	e.hub.NotifyMentionCount(e.connectedID(t, "older"), ok.Payload.Thread.ID, 2)
	if got := drainFor(newSend, 100*time.Millisecond); countType(got, MsgTypeMentionCount) != 1 {
		t.Fatalf("forums client mention_count: %q", got)
	}
	if got := drainFor(oldSend, 100*time.Millisecond); countType(got, MsgTypeMentionCount) != 0 {
		t.Fatalf("a client without forums got a post's mention_count: %q", got)
	}
	// A text-channel thread's badge still reaches it.
	e.hub.NotifyMentionCount(e.connectedID(t, "older"), e.thread, 1)
	if got := drainFor(oldSend, 100*time.Millisecond); countType(got, MsgTypeMentionCount) != 1 {
		t.Fatalf("a text thread's mention_count was withheld: %q", got)
	}
}

func (e *forumPostEnv) connectedID(t *testing.T, name string) int64 {
	t.Helper()
	u, err := e.database.GetUserByUsername(context.Background(), name)
	if err != nil || u == nil {
		t.Fatalf("user %s: %v", name, err)
	}
	return u.ID
}

// Reconnect replay: a socket without the feature replays nothing that was
// sequenced on a forum.
func TestDropForumChannels(t *testing.T) {
	e := newForumPostEnv(t)
	ctx := context.Background()
	oldC, _ := e.connectWith(t, "older", false)
	newC, _ := e.connectWith(t, "newer", true)
	for name, c := range map[string]*Client{"old": oldC, "new": newC} {
		allowed := map[int64]bool{e.parent: true, e.forum: true}
		readable := map[int64]bool{e.parent: true, e.forum: true}
		if err := e.hub.dropForumChannels(ctx, e.hub.readers.Visibility, c, allowed, readable); err != nil {
			t.Fatal(err)
		}
		wantForum := name == "new"
		if allowed[e.forum] != wantForum || readable[e.forum] != wantForum || !allowed[e.parent] || !readable[e.parent] {
			t.Errorf("%s: allowed=%v readable=%v", name, allowed, readable)
		}
	}
}

// Carry-over (c): the role worker reads the client's features when it sends,
// not before its lookups. A reconnect without the feature that lands between
// the verdicts and the send must not be sent the forum.
func TestRoleRefresh_ReadsFeaturesAtSendTime(t *testing.T) {
	e := newForumPostEnv(t)
	ctx := context.Background()
	u := e.poster
	hadForums := make(chan []byte, 256)
	first := NewTestClientWithUser(e.hub, u, 0, hadForums)
	first.features = clientFeatures{forums: true}
	e.hub.RegisterNowForTest(first)

	reconnected := make(chan []byte, 256)
	second := NewTestClientWithUser(e.hub, u, 0, reconnected)
	// The reconnect lands after the verdicts. It registers on its own goroutine:
	// the gate runs under the round's serialiser, and registering takes a lock
	// that ranks before it (the deadlock build rejects the nesting).
	g := func(int64) {
		done := make(chan struct{})
		go func() { defer close(done); e.hub.RegisterNowForTest(second) }()
		<-done
	}
	e.hub.roleRefresh.sendGate.Store(&g)
	e.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{u.ID}})
	e.hub.flushRoleRefresh(ctx)

	frames := drainFor(reconnected, 200*time.Millisecond)
	if countType(frames, MsgTypeChannelCreate) == 0 {
		t.Fatalf("the reconnected client got no sidebar at all: %q", frames)
	}
	for _, f := range frames {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				ID float64 `json:"id"`
			} `json:"payload"`
		}
		if json.Unmarshal(f, &env) == nil && env.Type == MsgTypeChannelCreate && int64(env.Payload.ID) == e.forum {
			t.Fatalf("a client that never declared forums was sent the forum: %s", f)
		}
	}
}

// The real reconnect path: an older client resuming behind a thread_changed
// that was sequenced on a forum is replayed the rest and is not forced onto a
// full ready; a client that declared forums is replayed the forum's frame.
//
// The synthetic frame carries payload.channel_id, which the real thread_changed
// does not: the replay content gate reads that key (payloadChannelID), so the
// frame here stands for "a content frame on the forum" to exercise the gate this
// test is about.
func TestReconnect_ForumFrameIsNotReplayedToOldClient(t *testing.T) {
	t.Parallel()
	setup := func(t *testing.T) (*Hub, string) {
		t.Helper()
		database := newTeardownTestDB(t)
		ctx := context.Background()
		userID, err := database.CreateUser(ctx, "resume-forum-user", "hash", int(permissions.MemberRoleID))
		if err != nil {
			t.Fatal(err)
		}
		text, err := database.CreateChannel(ctx, "resume-text", "text", "", "", 0)
		if err != nil {
			t.Fatal(err)
		}
		forum, err := database.CreateChannel(ctx, "resume-forum", "forum", "", "", 1)
		if err != nil {
			t.Fatal(err)
		}
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := database.CreateSession(ctx, userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatal(err)
		}
		hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
		go hub.Run()
		t.Cleanup(hub.Stop)
		rb := hub.ReplayBuffer()
		rb.Push(98, text, []byte(`{"seq":98,"type":"chat_message","payload":{"channel_id":`+itoaTest(text)+`,"content":"pre-existing"}}`))
		rb.Push(99, text, []byte(`{"seq":99,"type":"chat_message","payload":{"channel_id":`+itoaTest(text)+`,"content":"anchor"}}`))
		rb.Push(100, forum, []byte(`{"seq":100,"type":"thread_changed","payload":{"channel_id":`+itoaTest(forum)+`,"thread":{"id":9,"parent_id":`+itoaTest(forum)+`}}}`))
		rb.Push(101, text, []byte(`{"seq":101,"type":"chat_message","payload":{"channel_id":`+itoaTest(text)+`,"content":"AFTER-THE-FORUM-FRAME"}}`))
		return hub, token
	}
	has := func(frames [][]byte, needle string) bool {
		for _, f := range frames {
			if strings.Contains(string(f), needle) {
				return true
			}
		}
		return false
	}

	t.Run("old client", func(t *testing.T) {
		hub, token := setup(t)
		frames := dialAndResume(t, hub, token, 99)
		if has(frames, `"thread_changed"`) {
			t.Fatalf("an old client was replayed a forum frame: %q", frames)
		}
		if !has(frames, "AFTER-THE-FORUM-FRAME") || has(frames, `"type":"ready"`) {
			t.Fatalf("the resume should replay the rest without a full ready: %q", frames)
		}
	})
	t.Run("client with forums", func(t *testing.T) {
		hub, token := setup(t)
		frames := dialAndResumeWith(t, hub, token, 99, []string{"forums"})
		if !has(frames, `"thread_changed"`) || !has(frames, "AFTER-THE-FORUM-FRAME") {
			t.Fatalf("a forums client should be replayed the forum frame: %q", frames)
		}
	})
}

// forum_post_create_ok carries skipped_attachment_ids as chat_send_ok does, and
// leaves the thread out of a bare acknowledgement.
func TestBuildForumPostCreateOK_SkippedAndBareAck(t *testing.T) {
	var got struct {
		Payload map[string]json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(buildForumPostCreateOK("r", nil, 7, "c", true, []string{"a", "b"}), &got); err != nil {
		t.Fatal(err)
	}
	if _, has := got.Payload["thread"]; has {
		t.Errorf("a bare acknowledgement carried a thread: %v", got.Payload)
	}
	if string(got.Payload["skipped_attachment_ids"]) != `["a","b"]` {
		t.Errorf("skipped_attachment_ids = %s", got.Payload["skipped_attachment_ids"])
	}
	got.Payload = nil // json.Unmarshal merges into an existing map
	if err := json.Unmarshal(buildForumPostCreateOK("r", nil, 7, "c", false, nil), &got); err != nil {
		t.Fatal(err)
	}
	if _, has := got.Payload["skipped_attachment_ids"]; has {
		t.Error("skipped_attachment_ids present when nothing was skipped")
	}
}
