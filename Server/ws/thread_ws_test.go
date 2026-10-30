package ws

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

type threadWSFixture struct {
	database *db.DB
	svc      *service.Services
	hub      *Hub
	parent   int64
	thread   int64
}

func newThreadWSFixture(t *testing.T) *threadWSFixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	ctx := context.Background()
	parent, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	owner, err := database.CreateUser(ctx, "starter", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	res, err := database.ExecContext(ctx, `INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'hi')`, parent, owner)
	if err != nil {
		t.Fatalf("starter: %v", err)
	}
	starter, _ := res.LastInsertId()
	info, _, err := database.CreateThread(ctx, db.NewThread{
		ParentID: parent, StarterMessageID: starter, OwnerID: owner, Name: "t", AutoArchiveMinutes: 1440,
	})
	if err != nil {
		t.Fatalf("CreateThread: %v", err)
	}
	svc := service.New(database, auth.NewRateLimiter())
	hub := newTestHub(t, database, nil, svc)
	go hub.Run()
	t.Cleanup(func() {
		hub.Stop()
		<-hub.Done()
	})
	return &threadWSFixture{database: database, svc: svc, hub: hub, parent: parent, thread: info.ID}
}

func (f *threadWSFixture) connect(t *testing.T, name string) (*Client, chan []byte) {
	t.Helper()
	id, err := f.database.CreateUser(context.Background(), name, "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	u, err := f.database.GetUserByID(context.Background(), id)
	if err != nil || u == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	send := make(chan []byte, 256)
	c := NewTestClientWithUser(f.hub, u, 0, send)
	f.hub.RegisterNowForTest(c)
	return c, send
}

func drainFor(ch <-chan []byte, d time.Duration) [][]byte {
	var out [][]byte
	for {
		select {
		case m := <-ch:
			out = append(out, m)
		case <-time.After(d):
			return out
		}
	}
}

func countType(frames [][]byte, typ string) int {
	n := 0
	for _, f := range frames {
		if bytes.Contains(f, []byte(`"type":"`+typ+`"`)) {
			n++
		}
	}
	return n
}

// The security edge: a socket focused on a thread loses it, silently, when the
// parent's override starts denying READ.
func TestThreadFocus_ParentOverrideRevokes(t *testing.T) {
	t.Parallel()
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "reader")

	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != f.thread {
		t.Fatalf("focus refused for a reader: threadID=%d", c.getThreadID())
	}
	f.hub.BroadcastToChannel(f.thread, []byte(`{"type":"chat_message","payload":{"content":"before"}}`))
	if countType(drainFor(send, 300*time.Millisecond), "chat_message") != 1 {
		t.Fatal("setup: a focused socket gets the thread's frames")
	}

	if _, err := f.database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		f.parent, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	parent, err := f.database.GetChannel(context.Background(), f.parent)
	if err != nil || parent == nil {
		t.Fatalf("GetChannel: %v", err)
	}
	f.hub.RefreshChannelVisibility(parent)

	if c.getThreadID() != 0 {
		t.Fatalf("threadID = %d after the parent denied READ, want 0", c.getThreadID())
	}
	f.hub.BroadcastToChannel(f.thread, []byte(`{"type":"chat_message","payload":{"content":"after"}}`))
	if got := drainFor(send, 300*time.Millisecond); countType(got, "chat_message") != 0 {
		t.Fatalf("a revoked socket still received thread frames: %q", got)
	}
}

// Focusing a thread whose parent the user cannot read is refused outright.
func TestThreadFocus_RefusedWithoutParentRead(t *testing.T) {
	f := newThreadWSFixture(t)
	if _, err := f.database.ExecContext(context.Background(),
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, 4, 0, ?)`,
		f.parent, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	c, _ := f.connect(t, "outsider")
	if _, err := f.svc.Channels.AdmitThreadFocus(context.Background(), c.userID, f.thread); err == nil {
		t.Fatal("service admitted a thread focus without parent READ")
	}
	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != 0 {
		t.Fatalf("the live revalidation kept threadID=%d", c.getThreadID())
	}
}

// Closing the slot and moving it unsubscribes the old thread.
func TestThreadFocus_CloseUnsubscribes(t *testing.T) {
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "closer")
	f.hub.applyThreadFocus(c, f.thread)
	f.hub.applyThreadFocus(c, 0)
	f.hub.BroadcastToChannel(f.thread, []byte(`{"type":"chat_message","payload":{}}`))
	if got := drainFor(send, 300*time.Millisecond); len(got) != 0 {
		t.Fatalf("closed slot still receives: %q", got)
	}
}

// A burst of changes yields a bounded number of frames, and the timers die
// with the hub.
func TestThreadCoalescer_BoundsFramesAndStops(t *testing.T) {
	old := threadChangedInterval
	threadChangedInterval = 200 * time.Millisecond
	t.Cleanup(func() { threadChangedInterval = old })

	f := newThreadWSFixture(t)
	c, send := f.connect(t, "watcher")
	f.hub.pubsub.Subscribe(c, ChannelTopic(f.parent))

	for range 50 {
		f.hub.ThreadChanged(f.thread)
	}
	got := drainFor(send, 700*time.Millisecond)
	n := countType(got, MsgTypeThreadChanged)
	if n < 1 || n > 2 {
		t.Fatalf("%d thread_changed frames for one burst, want 1 or 2 (leading + trailing)", n)
	}

	f.hub.ThreadChanged(f.thread)
	f.hub.stopThreadFeed()
	f.hub.mu.RLock()
	left := len(f.hub.threadHub.timers)
	f.hub.mu.RUnlock()
	if left != 0 {
		t.Fatalf("%d timers survive the stop", left)
	}
	drainFor(send, 100*time.Millisecond)
	f.hub.ThreadChanged(f.thread)
	if got := drainFor(send, 400*time.Millisecond); countType(got, MsgTypeThreadChanged) != 0 {
		t.Fatal("a stopped coalescer still sends")
	}
}

// A hub built without the thread service advertises no threads capability.
func TestThreadCapability_AbsentWithoutService(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatal(err)
	}
	h := newTestHub(t, database, nil, nil)
	if h.threadHub.svc != nil {
		t.Fatal("bare hub has a thread service")
	}
}

// The role worker copies the parent's verdict to a socket holding one of its
// threads: a member who loses READ loses the thread too, with no frame.
func TestThreadFocus_RoleWorkerCopiesParentVerdict(t *testing.T) {
	f := newThreadWSFixture(t)
	c, _ := f.connect(t, "demoted")
	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != f.thread {
		t.Fatal("setup: focus refused")
	}
	if _, err := f.database.ExecContext(context.Background(), `UPDATE roles SET permissions = 0 WHERE id = 4`); err != nil {
		t.Fatal(err)
	}
	f.svc.Permissions.InvalidateAll()
	f.hub.EnqueueRoleRefresh(RoleRefresh{Visibility: []int64{c.userID}})
	waitFor(t, "the role worker to release the thread", func() bool { return c.getThreadID() == 0 })
}

// THREAD_EXISTS carries the winner's id on the error frame.
func TestThreadErrorToResult_ExistsCarriesThreadID(t *testing.T) {
	res := threadErrorToResult(&service.ThreadExistsError{ThreadID: 77})
	var ce ClientError
	ok := errors.As(res.Error, &ce)
	if !ok || ce.Code != ErrCodeThreadExists || ce.ThreadID != 77 {
		t.Fatalf("result = %+v", res)
	}
	frame := buildThreadErrorMsg(ce, "req")
	if !bytes.Contains(frame, []byte(`"thread_id":77`)) || !bytes.Contains(frame, []byte(`THREAD_EXISTS`)) {
		t.Fatalf("frame = %s", frame)
	}
	locked := serviceErrorToResult(permissions.ErrThreadLocked)
	var lce ClientError
	if !errors.As(locked.Error, &lce) || lce.Code != ErrCodeThreadLocked {
		t.Fatalf("locked result = %+v", locked)
	}
}

// The ready payload's channel set is the parent list: an old client never sees
// a thread row, and a new one learns threads from the list route.
func TestThread_ChannelListHasNoThreadRows(t *testing.T) {
	f := newThreadWSFixture(t)
	chans, err := f.database.ListChannels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, ch := range chans {
		if ch.ID == f.thread || ch.Type == "thread" {
			t.Fatalf("channel list carries thread %d", ch.ID)
		}
	}
}

// A flush that read the thread before it was deleted must not announce it
// afterwards: the frame is dropped unless its timer entry is still live.
func TestThreadCoalescer_NoThreadChangedAfterDelete(t *testing.T) {
	t.Parallel()
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "watcher2")
	f.hub.pubsub.Subscribe(c, ChannelTopic(f.parent))

	e := &threadTimer{t: time.NewTimer(time.Hour)}
	t.Cleanup(func() { e.t.Stop() })
	f.hub.mu.Lock()
	f.hub.threadHub.timers = map[int64]*threadTimer{f.thread: e}
	f.hub.mu.Unlock()

	// The entry is dropped by the delete, as handleThreadNote does.
	f.hub.forgetThread(f.thread)
	f.hub.flushThreadChanged(f.thread, e)
	if got := drainFor(send, 300*time.Millisecond); countType(got, MsgTypeThreadChanged) != 0 {
		t.Fatalf("a flush for a deleted thread's entry sent %q", got)
	}

	// A live entry still flushes.
	f.hub.mu.Lock()
	f.hub.threadHub.timers[f.thread] = e
	f.hub.mu.Unlock()
	f.hub.flushThreadChanged(f.thread, e)
	if got := drainFor(send, 300*time.Millisecond); countType(got, MsgTypeThreadChanged) != 1 {
		t.Fatalf("a live entry did not flush: %q", got)
	}
}

func (f *threadWSFixture) postInThread(t *testing.T, userID int64) int64 {
	t.Helper()
	res, err := f.svc.Messages.SendMessage(context.Background(), service.SendMessageParams{
		ChannelID: f.thread, UserID: userID, Username: "u", RoleName: "member", Content: "reply",
	})
	if err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	return res.MessageID
}

// Deleting a message in a thread moves its count and last message, so the
// parent's viewers hear about it.
func TestThreadDelete_Message_NotesThread(t *testing.T) {
	f := newThreadWSFixture(t)
	owner, err := f.database.GetUserByUsername(context.Background(), "starter")
	if err != nil || owner == nil {
		t.Fatalf("starter: %v", err)
	}
	mid := f.postInThread(t, owner.ID)
	res := handleChatDeleteV2(context.Background(), ChatDeleteCmd{userID: owner.ID, MessageID: mid},
		ClientInfo{UserID: owner.ID}, ChatDeps{MessageSvc: f.svc.Messages})
	if res.Error != nil {
		t.Fatalf("delete: %v", res.Error)
	}
	var noted bool
	for _, ev := range res.Events {
		if n, ok := ev.(threadNoteEvt); ok && n.threadID == f.thread {
			noted = true
		}
	}
	if !noted {
		t.Fatal("a delete in a thread emitted no thread note")
	}
}

// A bulk delete or purge in a thread reaches the coalescer too.
func TestThreadDelete_Bulk_NotesThread(t *testing.T) {
	old := threadChangedInterval
	threadChangedInterval = 100 * time.Millisecond
	t.Cleanup(func() { threadChangedInterval = old })
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "watcher3")
	f.hub.pubsub.Subscribe(c, ChannelTopic(f.parent))
	f.hub.BroadcastChatBulkDeleted(f.thread, []int64{1})
	if got := drainFor(send, 500*time.Millisecond); countType(got, MsgTypeThreadChanged) != 1 {
		t.Fatalf("bulk delete in a thread: thread_changed frames = %d, want 1", countType(got, MsgTypeThreadChanged))
	}
	// An ordinary channel is not a thread: no frame, no timer left behind.
	f.hub.BroadcastChatBulkDeleted(f.parent, []int64{1})
	drainFor(send, 300*time.Millisecond)
	f.hub.mu.RLock()
	_, leaked := f.hub.threadHub.timers[f.parent]
	f.hub.mu.RUnlock()
	if leaked {
		t.Fatal("a bulk delete in an ordinary channel left a thread timer")
	}
}

// A release that lands between the slot being set and the Subscribe must not
// leave the socket subscribed to a thread its slot no longer names.
func TestThreadFocus_ReleaseDuringApplyLeavesNoTopic(t *testing.T) {
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "racer")
	threadFocusBeforeSubscribeHook = func(c *Client, id int64) { f.hub.releaseThreadSocket(c, id, nil) }
	t.Cleanup(func() { threadFocusBeforeSubscribeHook = nil })

	f.hub.applyThreadFocus(c, f.thread)
	if c.getThreadID() != 0 {
		t.Fatalf("slot = %d after a release, want 0", c.getThreadID())
	}
	f.hub.BroadcastToChannel(f.thread, []byte(`{"type":"chat_message","payload":{}}`))
	if got := drainFor(send, 300*time.Millisecond); len(got) != 0 {
		t.Fatalf("socket with an empty slot still receives the thread: %q", got)
	}
}
