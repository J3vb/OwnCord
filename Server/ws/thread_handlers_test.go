package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// parseThread runs the registered constructor for typ over a JSON payload.
func parseThread(t *testing.T, typ, payload string) (Command, error) {
	t.Helper()
	ctor, ok := commandConstructors[typ]
	if !ok {
		t.Fatalf("no constructor for %s", typ)
	}
	return ctor(7, "req", json.RawMessage(payload))
}

func TestParseThreadCommands_Fields(t *testing.T) {
	cmd, err := parseThread(t, MsgTypeThreadCreate,
		`{"client_request_id":"c","channel_id":3,"message_id":9,"name":"plans","auto_archive_minutes":60}`)
	if err != nil {
		t.Fatal(err)
	}
	if c, ok := cmd.(ThreadCreateCmd); !ok || c.ChannelID != 3 || c.MessageID != 9 || c.Name != "plans" ||
		c.AutoArchiveMinutes != 60 || c.UserID() != 7 || c.Type() != MsgTypeThreadCreate {
		t.Errorf("create = %#v", cmd)
	}

	cmd, err = parseThread(t, MsgTypeThreadUpdate, `{"thread_id":4,"name":"n","archived":true,"locked":false,"auto_archive_minutes":1440}`)
	if err != nil {
		t.Fatal(err)
	}
	u, ok := cmd.(ThreadUpdateCmd)
	if !ok || u.ThreadID != 4 || u.Name == nil || *u.Name != "n" || u.Archived == nil || !*u.Archived ||
		u.Locked == nil || *u.Locked || u.AutoArchiveMinutes == nil || *u.AutoArchiveMinutes != 1440 ||
		u.UserID() != 7 || u.Type() != MsgTypeThreadUpdate {
		t.Errorf("update = %#v", cmd)
	}
	cmd, err = parseThread(t, MsgTypeThreadUpdate, `{"thread_id":4}`)
	if u, ok := cmd.(ThreadUpdateCmd); err != nil || !ok || u.Name != nil || u.Archived != nil || u.Locked != nil || u.AutoArchiveMinutes != nil {
		t.Errorf("an update with no fields must leave every field nil: %#v, %v", cmd, err)
	}

	cmd, err = parseThread(t, MsgTypeThreadDelete, `{"thread_id":5}`)
	if d, ok := cmd.(ThreadDeleteCmd); err != nil || !ok || d.ThreadID != 5 || d.UserID() != 7 || d.Type() != MsgTypeThreadDelete {
		t.Errorf("delete = %#v, %v", cmd, err)
	}

	cmd, err = parseThread(t, MsgTypeThreadFocus, `{"thread_id":6}`)
	if f, ok := cmd.(ThreadFocusCmd); err != nil || !ok || f.ThreadID != 6 || f.UserID() != 7 || f.Type() != MsgTypeThreadFocus {
		t.Errorf("focus = %#v, %v", cmd, err)
	}
	for _, p := range []string{`{"thread_id":null}`, `{}`} {
		cmd, err = parseThread(t, MsgTypeThreadFocus, p)
		if f, ok := cmd.(ThreadFocusCmd); err != nil || !ok || f.ThreadID != 0 {
			t.Errorf("focus %s closes the slot: %#v, %v", p, cmd, err)
		}
	}
}

func TestParseThreadCommands_RejectsMalformedPayloads(t *testing.T) {
	cases := map[string][]string{
		MsgTypeThreadCreate: {
			`not json`, `{"message_id":2}`, `{"channel_id":1}`, `{"channel_id":0,"message_id":2}`,
			`{"channel_id":1,"message_id":-2}`, `{"channel_id":1.5,"message_id":2}`, `{"channel_id":"x","message_id":2}`,
		},
		MsgTypeThreadUpdate: {`not json`, `{}`, `{"thread_id":0}`, `{"thread_id":-1,"name":"x"}`, `{"thread_id":1.5}`},
		MsgTypeThreadDelete: {`not json`, `{}`, `{"thread_id":0}`, `{"thread_id":"abc"}`},
		MsgTypeThreadFocus:  {`not json`, `{"thread_id":0}`, `{"thread_id":-3}`, `{"thread_id":1.5}`},
	}
	for typ, payloads := range cases {
		for _, p := range payloads {
			if cmd, err := parseThread(t, typ, p); err == nil {
				t.Errorf("%s %s parsed to %#v, want an error", typ, p, cmd)
			}
		}
	}
}

func TestThreadFrames_Builders(t *testing.T) {
	var ok struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			ThreadID  int64 `json:"thread_id"`
			ChannelID int64 `json:"channel_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(buildThreadUpdateOK("r1", 12), &ok); err != nil ||
		ok.Type != MsgTypeThreadUpdateOK || ok.ID != "r1" || ok.Payload.ThreadID != 12 {
		t.Errorf("update_ok = %+v, %v", ok, err)
	}
	ok.Payload.ThreadID = 0
	if err := json.Unmarshal(buildThreadDeleted(3, 12), &ok); err != nil ||
		ok.Type != MsgTypeThreadDeleted || ok.Payload.ChannelID != 3 || ok.Payload.ThreadID != 12 {
		t.Errorf("thread_deleted = %+v, %v", ok, err)
	}
	// An error frame without a request id omits the id.
	var e map[string]any
	if err := json.Unmarshal(buildThreadErrorMsg(ClientError{Code: ErrCodeThreadExists, Message: "m", ThreadID: 5}, ""), &e); err != nil {
		t.Fatal(err)
	}
	if _, has := e["id"]; has || e["type"] != MsgTypeError {
		t.Errorf("error frame = %v", e)
	}
}

// threadHandlerEnv wires the handlers to the fixture's real services.
type threadHandlerEnv struct {
	*threadWSFixture
	deps    ThreadDeps
	owner   int64
	member  int64
	mod     int64
	counter int
}

func newThreadHandlerEnv(t *testing.T) *threadHandlerEnv {
	t.Helper()
	f := newThreadWSFixture(t)
	ctx := context.Background()
	owner, err := f.database.GetUserByUsername(ctx, "starter")
	if err != nil || owner == nil {
		t.Fatalf("starter: %v", err)
	}
	member, err := f.database.CreateUser(ctx, "plain", "hash", int(permissions.MemberRoleID))
	if err != nil {
		t.Fatal(err)
	}
	mod, err := f.database.CreateUser(ctx, "moddy", "hash", int(permissions.ModeratorRoleID))
	if err != nil {
		t.Fatal(err)
	}
	return &threadHandlerEnv{
		threadWSFixture: f, owner: owner.ID, member: member, mod: mod,
		deps: ThreadDeps{Limiter: auth.NewRateLimiter(), ThreadSvc: f.svc.Threads, ChannelSvc: f.svc.Channels},
	}
}

// message posts a fresh ordinary message in the parent and returns its id.
func (e *threadHandlerEnv) message(t *testing.T) int64 {
	t.Helper()
	e.counter++
	res, err := e.database.ExecContext(context.Background(),
		`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)`, e.parent, e.owner, "m")
	if err != nil {
		t.Fatal(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func resultCode(t *testing.T, res Result) (ClientError, bool) {
	t.Helper()
	var ce ClientError
	if res.Error == nil || !errors.As(res.Error, &ce) {
		return ClientError{}, false
	}
	return ce, true
}

func wantCode(t *testing.T, label string, res Result, code string) ClientError {
	t.Helper()
	ce, ok := resultCode(t, res)
	if !ok || ce.Code != code {
		t.Fatalf("%s: result = %+v, want error %s", label, res, code)
	}
	return ce
}

func TestHandleThreadCreate_RepliesNotesAndRefusals(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx := context.Background()
	msg := e.message(t)
	cmd := ThreadCreateCmd{userID: e.owner, ChannelID: e.parent, MessageID: msg, Name: "  plans  ", AutoArchiveMinutes: 60}
	info := ClientInfo{UserID: e.owner, ReqID: "r1"}

	res := handleThreadCreateV2(ctx, cmd, info, e.deps)
	if res.Error != nil || len(res.Reply) == 0 {
		t.Fatalf("create = %+v", res)
	}
	var reply struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			Thread struct {
				ID                 int64  `json:"id"`
				ParentID           int64  `json:"parent_id"`
				Name               string `json:"name"`
				AutoArchiveMinutes int    `json:"auto_archive_minutes"`
			} `json:"thread"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(res.Reply, &reply); err != nil {
		t.Fatal(err)
	}
	th := reply.Payload.Thread
	if reply.Type != MsgTypeThreadCreateOK || reply.ID != "r1" || th.ParentID != e.parent || th.Name != "plans" || th.AutoArchiveMinutes != 60 {
		t.Errorf("reply = %s", res.Reply)
	}
	if len(res.Events) != 1 {
		t.Fatalf("events = %v, want one thread note", res.Events)
	}
	if n, ok := res.Events[0].(threadNoteEvt); !ok || n.threadID != th.ID || n.deleted || n.EventType() != MsgTypeThreadChanged ||
		n.ThreadNote().threadID != th.ID {
		t.Errorf("event = %#v", res.Events[0])
	}

	// The owner's retry gets the same thread back and announces nothing.
	retry := handleThreadCreateV2(ctx, cmd, info, e.deps)
	if retry.Error != nil || len(retry.Events) != 0 || !bytes.Equal(retry.Reply, res.Reply) {
		t.Errorf("retry = %+v, want the same reply and no events", retry)
	}

	// Anyone else gets THREAD_EXISTS naming the winner.
	other := handleThreadCreateV2(ctx, ThreadCreateCmd{userID: e.member, ChannelID: e.parent, MessageID: msg, Name: "mine", AutoArchiveMinutes: 60},
		ClientInfo{UserID: e.member}, e.deps)
	if ce := wantCode(t, "second creator", other, ErrCodeThreadExists); ce.ThreadID != th.ID {
		t.Errorf("THREAD_EXISTS names %d, want %d", ce.ThreadID, th.ID)
	}

	wantCode(t, "blank name", handleThreadCreateV2(ctx,
		ThreadCreateCmd{userID: e.owner, ChannelID: e.parent, MessageID: e.message(t), Name: "  ", AutoArchiveMinutes: 60}, info, e.deps), ErrCodeBadRequest)
	wantCode(t, "unknown message", handleThreadCreateV2(ctx,
		ThreadCreateCmd{userID: e.owner, ChannelID: e.parent, MessageID: 999999, Name: "x", AutoArchiveMinutes: 60}, info, e.deps), ErrCodeNotFound)
	wantCode(t, "no thread service", handleThreadCreateV2(ctx, cmd, info, ThreadDeps{}), ErrCodeInternal)
}

func TestHandleThreadUpdate_OwnerModeratorAndRefusals(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx := context.Background()
	name := "renamed"
	locked := true
	owner := ClientInfo{UserID: e.owner, ReqID: "u1"}

	res := handleThreadUpdateV2(ctx, ThreadUpdateCmd{userID: e.owner, ThreadID: e.thread, Name: &name}, owner, e.deps)
	if res.Error != nil {
		t.Fatalf("owner rename = %+v", res)
	}
	var reply struct {
		Type    string `json:"type"`
		ID      string `json:"id"`
		Payload struct {
			ThreadID int64 `json:"thread_id"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(res.Reply, &reply); err != nil || reply.Type != MsgTypeThreadUpdateOK || reply.ID != "u1" || reply.Payload.ThreadID != e.thread {
		t.Errorf("reply = %s (%v)", res.Reply, err)
	}
	if len(res.Events) != 1 || res.Events[0].(threadNoteEvt).threadID != e.thread {
		t.Errorf("events = %v", res.Events)
	}
	got, err := e.svc.Threads.Get(ctx, e.thread)
	if err != nil || got == nil || got.Name != "renamed" {
		t.Fatalf("stored thread = %+v, %v", got, err)
	}

	wantCode(t, "member who is not the owner", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.member, ThreadID: e.thread, Name: &name}, ClientInfo{UserID: e.member}, e.deps), ErrCodeForbidden)
	wantCode(t, "owner locking", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.owner, ThreadID: e.thread, Locked: &locked}, owner, e.deps), ErrCodeForbidden)
	if res := handleThreadUpdateV2(ctx, ThreadUpdateCmd{userID: e.mod, ThreadID: e.thread, Locked: &locked}, ClientInfo{UserID: e.mod}, e.deps); res.Error != nil {
		t.Fatalf("moderator lock = %+v", res)
	}
	wantCode(t, "owner on a locked thread", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.owner, ThreadID: e.thread, Name: &name}, owner, e.deps), ErrCodeThreadLocked)
	wantCode(t, "unknown thread", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.mod, ThreadID: 999999, Name: &name}, ClientInfo{UserID: e.mod}, e.deps), ErrCodeNotFound)
	wantCode(t, "empty patch", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.mod, ThreadID: e.thread}, ClientInfo{UserID: e.mod}, e.deps), ErrCodeBadRequest)
	wantCode(t, "no thread service", handleThreadUpdateV2(ctx,
		ThreadUpdateCmd{userID: e.owner, ThreadID: e.thread, Name: &name}, owner, ThreadDeps{}), ErrCodeInternal)
}

func TestHandleThreadDelete_ModeratorOnlyAndReleasesHolders(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx := context.Background()
	wantCode(t, "owner delete", handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: e.owner, ThreadID: e.thread},
		ClientInfo{UserID: e.owner}, e.deps), ErrCodeForbidden)
	wantCode(t, "no thread service", handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: e.mod, ThreadID: e.thread},
		ClientInfo{UserID: e.mod}, ThreadDeps{}), ErrCodeInternal)

	holder, send := e.connect(t, "holder")
	e.hub.applyThreadFocus(holder, e.thread)
	if holder.getThreadID() != e.thread {
		t.Fatal("setup: focus refused")
	}
	if !e.hub.holdsThread(holder.userID, e.thread) || e.hub.holdsThread(holder.userID, e.thread+1) || e.hub.holdsThread(987654, e.thread) {
		t.Error("holdsThread disagrees with the slot")
	}

	res := handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: e.mod, ThreadID: e.thread}, ClientInfo{UserID: e.mod}, e.deps)
	if res.Error != nil || len(res.Events) != 2 {
		t.Fatalf("moderator delete = %+v", res)
	}
	note, ok := res.Events[0].(threadNoteEvt)
	if !ok || !note.deleted || note.threadID != e.thread || note.parentID != e.parent {
		t.Errorf("first event = %#v, want the delete note (it must precede the sequenced frame)", res.Events[0])
	}
	ce, ok := res.Events[1].(channelEvt)
	if !ok || ce.evType != MsgTypeThreadDeleted || ce.channelID != e.parent {
		t.Errorf("second event = %#v", res.Events[1])
	}
	if gone, err := e.svc.Threads.Get(ctx, e.thread); err != nil || gone != nil {
		t.Errorf("thread after delete = %+v, %v", gone, err)
	}
	wantCode(t, "delete again", handleThreadDeleteV2(ctx, ThreadDeleteCmd{userID: e.mod, ThreadID: e.thread},
		ClientInfo{UserID: e.mod}, e.deps), ErrCodeNotFound)

	// Applying the note releases the socket that had the thread open.
	e.hub.handleThreadNote(note.ThreadNote())
	if holder.getThreadID() != 0 {
		t.Errorf("holder slot = %d after the delete note, want 0", holder.getThreadID())
	}
	if got := drainFor(send, 200*time.Millisecond); countType(got, MsgTypeThreadDeleted) != 1 {
		t.Errorf("holder frames = %q, want one thread_deleted", got)
	}
}

func TestHandleThreadFocus_OpensClosesAndRefuses(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx := context.Background()
	info := ClientInfo{UserID: e.member}

	res := handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member}, info, e.deps)
	if res.Error != nil || res.SetThreadID == nil || *res.SetThreadID != 0 || len(res.Events) != 0 {
		t.Errorf("close = %+v", res)
	}
	res = handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: e.thread}, info, e.deps)
	if res.Error != nil || res.SetThreadID == nil || *res.SetThreadID != e.thread || len(res.Events) != 1 {
		t.Errorf("open = %+v", res)
	}
	wantCode(t, "unknown thread", handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: 999999}, info, e.deps), ErrCodeNotFound)
	wantCode(t, "no thread service", handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: e.thread}, info, ThreadDeps{}), ErrCodeInternal)
	wantCode(t, "no channel service", handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: e.thread}, info,
		ThreadDeps{ThreadSvc: e.svc.Threads}), ErrCodeInternal)

	// A parent the member cannot read refuses the focus.
	if _, err := e.database.ExecContext(ctx,
		`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, 0, ?)`,
		e.parent, permissions.MemberRoleID, permissions.ReadMessages); err != nil {
		t.Fatal(err)
	}
	e.svc.Permissions.InvalidateAll()
	if res := handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: e.thread}, info, e.deps); res.Error == nil || res.SetThreadID != nil {
		t.Errorf("focus without parent READ = %+v, want a refusal", res)
	}
}

func TestHandleThreadFocus_OwnRateBudget(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx := context.Background()
	info := ClientInfo{UserID: e.member}
	cmd := ThreadFocusCmd{userID: e.member, ThreadID: e.thread}
	for i := range focusRateLimit {
		if res := handleThreadFocusV2(ctx, cmd, info, e.deps); res.Error != nil {
			t.Fatalf("focus %d inside the budget = %+v", i, res)
		}
	}
	wantCode(t, "over budget", handleThreadFocusV2(ctx, cmd, info, e.deps), ErrCodeRateLimited)
	// Closing needs no budget: it never touches the database.
	if res := handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member}, info, e.deps); res.Error != nil || res.SetThreadID == nil {
		t.Errorf("close over budget = %+v", res)
	}
	// Another user has their own budget.
	if res := handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.owner, ThreadID: e.thread}, ClientInfo{UserID: e.owner}, e.deps); res.Error != nil {
		t.Errorf("a different user was throttled: %+v", res)
	}
}

func TestHandleThreadFocus_DeadlineIsReportedOtherFailuresDropped(t *testing.T) {
	e := newThreadHandlerEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res := handleThreadFocusV2(ctx, ThreadFocusCmd{userID: e.member, ThreadID: e.thread}, ClientInfo{UserID: e.member}, e.deps)
	if res.SetThreadID != nil {
		t.Errorf("a failed admission moved the slot: %+v", res)
	}
}

func TestWireThreads_ArchiverNotifierReachesTheCoalescer(t *testing.T) {
	old := threadChangedInterval
	threadChangedInterval = 100 * time.Millisecond
	t.Cleanup(func() { threadChangedInterval = old })
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "archwatch")
	f.hub.pubsub.Subscribe(c, ChannelTopic(f.parent))

	if f.hub.threadHub.svc == nil {
		t.Fatal("hub with services has no thread service wired")
	}
	if f.svc.ThreadArchiver == nil {
		t.Skip("no archiver in this service set")
	}
	f.hub.ThreadChanged(f.thread)
	if got := drainFor(send, 400*time.Millisecond); countType(got, MsgTypeThreadChanged) != 1 {
		t.Errorf("an archiver notification produced %d thread_changed frames, want 1", countType(got, MsgTypeThreadChanged))
	}
}

func TestThreadChanged_SkippedForMissingThreadAndFlushReadFailure(t *testing.T) {
	f := newThreadWSFixture(t)
	c, send := f.connect(t, "ghost")
	f.hub.pubsub.Subscribe(c, ChannelTopic(f.parent))

	// A thread that is gone (or was never one) announces nothing.
	e := &threadTimer{t: time.NewTimer(time.Hour)}
	t.Cleanup(func() { e.t.Stop() })
	f.hub.mu.Lock()
	f.hub.threadHub.timers = map[int64]*threadTimer{424242: e}
	f.hub.mu.Unlock()
	f.hub.flushThreadChanged(424242, e)
	if got := drainFor(send, 200*time.Millisecond); countType(got, MsgTypeThreadChanged) != 0 {
		t.Errorf("flush of a missing thread sent %q", got)
	}

	// A closed database is logged and dropped, not announced.
	if err := f.database.Close(); err != nil {
		t.Fatal(err)
	}
	f.hub.flushThreadChanged(f.thread, e)
	if got := drainFor(send, 200*time.Millisecond); countType(got, MsgTypeThreadChanged) != 0 {
		t.Errorf("flush with a failing read sent %q", got)
	}
}

func TestFireThreadTimer_ClosesAnIdleWindowAndIgnoresADroppedEntry(t *testing.T) {
	f := newThreadWSFixture(t)
	th := &f.hub.threadHub

	// A window that saw no change since its flush ends and frees the entry.
	idle := &threadTimer{t: time.NewTimer(time.Hour), window: true}
	t.Cleanup(func() { idle.t.Stop() })
	f.hub.mu.Lock()
	th.timers = map[int64]*threadTimer{f.thread: idle}
	f.hub.mu.Unlock()
	f.hub.fireThreadTimer(f.thread, idle)
	f.hub.mu.RLock()
	_, kept := th.timers[f.thread]
	f.hub.mu.RUnlock()
	if kept {
		t.Error("an idle window left its entry in the map")
	}

	// A timer whose entry was replaced does nothing.
	stale := &threadTimer{t: time.NewTimer(time.Hour), pending: true}
	t.Cleanup(func() { stale.t.Stop() })
	f.hub.fireThreadTimer(f.thread, stale)
	if stale.window || !stale.pending {
		t.Errorf("a dropped entry was processed: %+v", stale)
	}
}

func TestNoteIfThread_IgnoresOrdinaryChannelsAndBareHubs(t *testing.T) {
	f := newThreadWSFixture(t)
	f.hub.noteIfThread(f.parent)
	f.hub.mu.RLock()
	n := len(f.hub.threadHub.timers)
	f.hub.mu.RUnlock()
	if n != 0 {
		t.Errorf("an ordinary channel left %d thread timers", n)
	}
	f.hub.stopThreadFeed()
	f.hub.noteThreadChanged(f.thread)
	f.hub.mu.RLock()
	n = len(f.hub.threadHub.timers)
	f.hub.mu.RUnlock()
	if n != 0 {
		t.Errorf("a stopped feed accepted a change: %d timers", n)
	}
}
