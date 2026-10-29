package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

type activityFixture struct {
	hub     *Hub
	db      *db.DB
	svc     *service.Services
	textID  int64
	voiceID int64
	author  *db.User
}

func newActivityFixture(t *testing.T) *activityFixture {
	t.Helper()
	return newActivityFixtureStore(t, func(d *db.DB) service.Store { return d }, true)
}

// newActivityFixtureStore builds the fixture over wrap(database) as the
// services' store; inlineMentions runs the mention-count write inline, false
// leaves the production mention path (the caller starts the worker).
func newActivityFixtureStore(t *testing.T, wrap func(*db.DB) service.Store, inlineMentions bool) *activityFixture {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	limiter := auth.NewRateLimiter()
	svc := service.New(wrap(database), limiter)
	hub := newTestHub(t, database, limiter, svc)
	if inlineMentions {
		hub.RunMentionCountsInlineForTest()
	}

	ctx := context.Background()
	textID, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel(text): %v", err)
	}
	voiceID, err := database.CreateChannel(ctx, "voice", "voice", "", "", 1)
	if err != nil {
		t.Fatalf("CreateChannel(voice): %v", err)
	}
	f := &activityFixture{hub: hub, db: database, svc: svc, textID: textID, voiceID: voiceID}
	f.author = f.user(t, "author", permissions.OwnerRoleID)
	return f
}

func (f *activityFixture) user(t *testing.T, name string, roleID int64) *db.User {
	t.Helper()
	ctx := context.Background()
	if _, err := f.db.CreateUser(ctx, name, "hash", int(roleID)); err != nil {
		t.Fatalf("CreateUser(%s): %v", name, err)
	}
	u, err := f.db.GetUserByUsername(ctx, name)
	if err != nil || u == nil {
		t.Fatalf("GetUserByUsername(%s): %v", name, err)
	}
	return u
}

// connect registers a connected client for u; focus > 0 subscribes it to that
// channel's topic, as channel_focus does.
func (f *activityFixture) connect(u *db.User, focus int64) chan []byte {
	return registerEmitTestClient(f.hub, u.ID, focus)
}

// send drives a chat_send through the real handler and emits only the
// coalescer's events, so the test needs no dispatch goroutine.
func (f *activityFixture) send(t *testing.T, from *db.User, chID int64, content string) (Result, int64) {
	t.Helper()
	res := handleChatSendV2(context.Background(),
		ChatSendCmd{ChannelID: chID, Content: content},
		ClientInfo{UserID: from.ID, Username: from.Username, RoleName: "owner"},
		ChatDeps{Limiter: f.hub.limiter, MessageSvc: f.svc.Messages, LiveStatus: f.hub.LiveStatus})
	if res.Error != nil {
		t.Fatalf("chat_send %q: %v", content, res.Error)
	}
	var msgID int64
	for _, ev := range res.Events {
		if ae, ok := ev.(ActivityEvent); ok {
			f.hub.EmitEvents(context.Background(), []Event{ev})
			msgID = ae.ActivityNote().msgID
		}
	}
	return res, msgID
}

func (f *activityFixture) flush() { f.hub.flushChannelActivity(context.Background()) }

type activityWireEntry struct {
	ChannelID        int64  `json:"channel_id"`
	MessageID        int64  `json:"message_id"`
	AuthorID         *int64 `json:"author_id"`
	MentionsYou      bool   `json:"mentions_you"`
	MentionsEveryone bool   `json:"mentions_everyone"`
}

// activityFrames drains ch and returns the entries of every channel_activity
// frame it holds, one slice per frame.
func activityFrames(ch chan []byte) [][]activityWireEntry {
	var out [][]activityWireEntry
	for _, m := range drainChan(ch, 60*time.Millisecond) {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Channels []activityWireEntry `json:"channels"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "channel_activity" {
			out = append(out, env.Payload.Channels)
		}
	}
	return out
}

func wantOneEntry(t *testing.T, who string, frames [][]activityWireEntry) activityWireEntry {
	t.Helper()
	if len(frames) != 1 || len(frames[0]) != 1 {
		t.Fatalf("%s: frames = %+v, want one frame with one entry", who, frames)
	}
	return frames[0][0]
}

func TestChannelActivity_ReachesUnfocusedReadersOnly(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	reader := f.user(t, "reader", permissions.MemberRoleID)
	denied := f.user(t, "denied", permissions.MemberRoleID)
	focused := f.user(t, "focused", permissions.MemberRoleID)
	if err := f.db.UpsertChannelUserOverride(ctx, f.textID, denied.ID, 0, permissions.ReadMessages); err != nil {
		t.Fatalf("UpsertChannelUserOverride: %v", err)
	}
	f.svc.Permissions.InvalidateAll()

	authorSend := f.connect(f.author, 0)
	readerSend := f.connect(reader, 0)
	deniedSend := f.connect(denied, 0)
	focusedSend := f.connect(focused, f.textID)

	res, msgID := f.send(t, f.author, f.textID, "hello")
	if len(res.Events) != 2 {
		t.Fatalf("events = %d, want chat_message then the activity note", len(res.Events))
	}
	if _, isChannel := res.Events[1].(ChannelEvent); isChannel {
		t.Fatal("the activity event satisfies ChannelEvent: it would be sequenced")
	}
	f.flush()

	e := wantOneEntry(t, "reader", activityFrames(readerSend))
	if e.ChannelID != f.textID || e.MessageID != msgID || e.AuthorID == nil || *e.AuthorID != f.author.ID ||
		e.MentionsYou || e.MentionsEveryone {
		t.Fatalf("reader entry = %+v, want channel %d message %d by %d, no flags", e, f.textID, msgID, f.author.ID)
	}
	for who, ch := range map[string]chan []byte{"denied": deniedSend, "focused": focusedSend, "author": authorSend} {
		if got := activityFrames(ch); len(got) != 0 {
			t.Errorf("%s received %+v, want nothing", who, got)
		}
	}

	// A DM send records nothing: its participants already get chat_message.
	if _, _, err := f.db.GetOrCreateDMChannel(ctx, f.author.ID, reader.ID); err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	if err := f.db.TrustSender(ctx, reader.ID, f.author.ID, "accepted"); err != nil {
		t.Fatalf("TrustSender: %v", err)
	}
	dm, _, err := f.db.GetOrCreateDMChannel(ctx, f.author.ID, reader.ID)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	dmRes, _ := f.send(t, f.author, dm.ID, "private")
	for _, ev := range dmRes.Events {
		if _, isActivity := ev.(ActivityEvent); isActivity {
			t.Fatal("a DM send produced an activity event")
		}
	}
	f.flush()
	if got := activityFrames(readerSend); len(got) != 0 {
		t.Errorf("DM send produced a hint: %+v", got)
	}
}

func TestChannelActivity_CoalescesBurst(t *testing.T) {
	f := newActivityFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	readerSend := f.connect(reader, 0)
	startActivityHub(t, f.hub)

	// The first send goes through the handler (and takes the leading edge);
	// the rest are noted directly, since chat_send's own rate limit would stop
	// a real burst of 50.
	_, last := f.send(t, f.author, f.textID, "burst 0")
	for range 49 {
		last++
		f.hub.NoteChannelActivityForTest(f.textID, last, f.author.ID)
	}

	var frames [][]activityWireEntry
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		frames = append(frames, activityFrames(readerSend)...)
		if n := len(frames); n > 0 && frames[n-1][len(frames[n-1])-1].MessageID == last {
			break
		}
	}
	frames = append(frames, activityFrames(readerSend)...)
	if len(frames) == 0 || len(frames) > 2 {
		t.Fatalf("50 messages produced %d frames, want 1 or 2", len(frames))
	}
	lastFrame := frames[len(frames)-1]
	if got := lastFrame[len(lastFrame)-1].MessageID; got != last {
		t.Fatalf("last frame ends at message %d, want the latest %d", got, last)
	}
}

func TestChannelActivity_MentionEntryKeptInBurst(t *testing.T) {
	f := newActivityFixture(t)
	mentioned := f.user(t, "mentioned", permissions.MemberRoleID)
	other := f.user(t, "other", permissions.MemberRoleID)
	mentionedSend := f.connect(mentioned, 0)
	otherSend := f.connect(other, 0)

	_, mentionID := f.send(t, f.author, f.textID, "@mentioned look")
	last := mentionID
	for range 10 {
		last++
		f.hub.NoteChannelActivityForTest(f.textID, last, f.author.ID)
	}
	f.flush()

	frames := activityFrames(mentionedSend)
	if len(frames) != 1 || len(frames[0]) != 2 {
		t.Fatalf("mentioned frames = %+v, want one frame with two entries", frames)
	}
	m, l := frames[0][0], frames[0][1]
	if m.MessageID != mentionID || !m.MentionsYou || m.MentionsEveryone {
		t.Errorf("first entry = %+v, want the mention (message %d, mentions_you)", m, mentionID)
	}
	if l.MessageID != last || l.MentionsYou || l.MentionsEveryone || l.MessageID <= m.MessageID {
		t.Errorf("second entry = %+v, want the latest message %d without flags, after the first", l, last)
	}
	if e := wantOneEntry(t, "other", activityFrames(otherSend)); e.MessageID != last || e.MentionsYou {
		t.Errorf("unmentioned entry = %+v, want only the latest message %d", e, last)
	}
}

func TestChannelActivity_EveryoneHereDirectBlocked(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	online := f.user(t, "online", permissions.MemberRoleID)
	offline := f.user(t, "offline", permissions.MemberRoleID)
	invisible := f.user(t, "invisible", permissions.MemberRoleID)
	blocker := f.user(t, "blocker", permissions.MemberRoleID)
	if err := f.db.BlockUser(ctx, blocker.ID, f.author.ID); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}

	sends := map[string]chan []byte{}
	for _, u := range []*db.User{online, offline, invisible, blocker} {
		sends[u.Username] = f.connect(u, 0)
	}
	f.hub.ClientForTest(online.ID).setLivePresence("online", nil, "")
	f.hub.ClientForTest(invisible.ID).setLivePresence("invisible", nil, "")
	f.hub.ClientForTest(blocker.ID).setLivePresence("online", nil, "")

	type flags struct{ you, everyone bool }
	check := func(label string, want map[string]flags) {
		t.Helper()
		for name, w := range want {
			e := wantOneEntry(t, label+"/"+name, activityFrames(sends[name]))
			if e.MentionsYou != w.you || e.MentionsEveryone != w.everyone {
				t.Errorf("%s/%s flags = (you %v, everyone %v), want (%v, %v)",
					label, name, e.MentionsYou, e.MentionsEveryone, w.you, w.everyone)
			}
		}
	}

	f.send(t, f.author, f.textID, "@everyone hi")
	f.flush()
	check("everyone", map[string]flags{
		"online": {false, true}, "offline": {false, true}, "invisible": {false, true}, "blocker": {false, false},
	})

	f.send(t, f.author, f.textID, "@here hi")
	f.flush()
	check("here", map[string]flags{
		"online": {false, true}, "offline": {false, false}, "invisible": {false, false}, "blocker": {false, false},
	})

	f.send(t, f.author, f.textID, "@online @blocker @everyone hi")
	f.flush()
	check("direct", map[string]flags{
		"online": {true, true}, "offline": {false, true}, "invisible": {false, true}, "blocker": {false, false},
	})
}

func TestChannelActivity_NSFWUnackedOmitsAuthor(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	acked := f.user(t, "acked", permissions.MemberRoleID)
	unacked := f.user(t, "unacked", permissions.MemberRoleID)
	if _, err := f.db.ExecContext(ctx, `UPDATE channels SET nsfw = 1 WHERE id = ?`, f.textID); err != nil {
		t.Fatalf("label channel: %v", err)
	}
	for _, uid := range []int64{f.author.ID, acked.ID} {
		if _, err := f.db.AcknowledgeNSFW(ctx, uid, f.textID); err != nil {
			t.Fatalf("AcknowledgeNSFW: %v", err)
		}
	}
	ackedSend := f.connect(acked, 0)
	unackedSend := f.connect(unacked, 0)

	_, msgID := f.send(t, f.author, f.textID, "@unacked @acked hi")
	f.flush()

	a := wantOneEntry(t, "acked", activityFrames(ackedSend))
	if a.AuthorID == nil || *a.AuthorID != f.author.ID || !a.MentionsYou {
		t.Errorf("acknowledged entry = %+v, want the author id and mentions_you", a)
	}
	// Read the raw frame: a nil AuthorID would also decode from "author_id":null.
	var raw [][]byte
	for _, m := range drainChan(unackedSend, 60*time.Millisecond) {
		if payloadType(m) == MsgTypeChannelActivity {
			raw = append(raw, m)
		}
	}
	if len(raw) != 1 {
		t.Fatalf("unacknowledged reader got %d frames, want 1", len(raw))
	}
	var env struct {
		Payload struct {
			Channels []map[string]any `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(raw[0], &env); err != nil || len(env.Payload.Channels) != 1 {
		t.Fatalf("decode %s: %v", raw[0], err)
	}
	u := env.Payload.Channels[0]
	if _, has := u["author_id"]; has {
		t.Errorf("unacknowledged entry carries author_id: %s", raw[0])
	}
	if u["channel_id"] != float64(f.textID) || u["message_id"] != float64(msgID) || u["mentions_you"] != true {
		t.Errorf("unacknowledged entry = %v, want channel, message and flags kept", u)
	}
}

func TestChannelActivity_UnsequencedNoLossMark(t *testing.T) {
	f := newActivityFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	full := make(chan []byte, 1)
	full <- []byte(`{"type":"filler"}`)
	c := NewTestClientWithUser(f.hub, reader, 0, full)
	f.hub.clients[reader.ID] = []*Client{c}

	seq := atomic.LoadUint64(&f.hub.seq)
	marks := f.hub.LossMarkCount()
	drops := f.hub.bpLowDrops.Load()

	f.send(t, f.author, f.textID, "into a full queue")
	f.flush()

	if got := atomic.LoadUint64(&f.hub.seq); got != seq {
		t.Errorf("h.seq moved %d -> %d: the hint was sequenced", seq, got)
	}
	if got := f.hub.LossMarkCount(); got != marks {
		t.Errorf("LossMarkCount moved %d -> %d: a dropped hint was marked as loss", marks, got)
	}
	if c.cseq.lossPending.Load() || c.cseq.out != 0 {
		t.Errorf("cseq state touched: pending=%v out=%d", c.cseq.lossPending.Load(), c.cseq.out)
	}
	if got := f.hub.bpLowDrops.Load(); got != drops+1 {
		t.Errorf("bpLowDrops = %d, want %d", got, drops+1)
	}
	if len(full) != 1 {
		t.Errorf("queue holds %d frames, want only the filler", len(full))
	}

	// With room, the frame is delivered bare: no seq to stamp a cseq onto.
	<-full
	f.send(t, f.author, f.textID, "into an empty queue")
	f.flush()
	select {
	case m := <-full:
		var env map[string]json.RawMessage
		if err := json.Unmarshal(m, &env); err != nil {
			t.Fatalf("decode %s: %v", m, err)
		}
		if _, has := env["seq"]; has {
			t.Errorf("hint carries a seq: %s", m)
		}
	default:
		t.Fatal("no frame delivered to a client with room")
	}
}

func TestChannelActivity_ReconnectInWindow(t *testing.T) {
	f := newActivityFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	oldSend := make(chan []byte, 8)
	old := NewTestClientWithUser(f.hub, reader, 0, oldSend)
	f.hub.registerNowTest(old, nil)

	startActivityHub(t, f.hub)
	// Two filler broadcasts first: the ring answers only for seqs after its oldest.
	f.hub.BroadcastToAll([]byte(`{"type":"filler"}`))
	f.hub.BroadcastToAll([]byte(`{"type":"filler"}`))
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
	fillerSeq := atomic.LoadUint64(&f.hub.seq)
	// Close the leading edge so the note waits in the window, as a second
	// message in a burst would.
	f.hub.activity.mu.Lock()
	f.hub.activity.lastFlush = time.Now().Add(time.Hour)
	f.hub.activity.mu.Unlock()
	res, _ := f.send(t, f.author, f.textID, "before the resume")
	f.hub.EmitEvents(context.Background(), res.Events[:1])
	if err := f.hub.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}

	newSend := make(chan []byte, 8)
	fresh := NewTestClientWithUser(f.hub, reader, 0, newSend)
	f.hub.registerNowTest(fresh, nil)
	seq := atomic.LoadUint64(&f.hub.seq)

	f.flush()

	if e := wantOneEntry(t, "new connection", activityFrames(newSend)); e.ChannelID != f.textID {
		t.Errorf("new connection entry = %+v", e)
	}
	for m := range oldSend {
		var env struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(m, &env) == nil && env.Type == "channel_activity" {
			t.Errorf("displaced connection received %s", m)
		}
	}
	if got := atomic.LoadUint64(&f.hub.seq); got != seq {
		t.Errorf("h.seq moved %d -> %d: the hint was sequenced", seq, got)
	}
	// The chat_message's content gate resolves off the dispatch goroutine, so
	// give the sequenced send a moment to reach the ring.
	var chatFrames int
	for deadline := time.Now().Add(3 * time.Second); chatFrames == 0 && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
		chatFrames = 0
		for _, data := range f.hub.replayBuf.EventsSince(fillerSeq) {
			switch payloadType(data) {
			case MsgTypeChannelActivity:
				t.Errorf("replay ring holds a channel_activity frame: %s", data)
			case MsgTypeChatMessage:
				chatFrames++
			}
		}
	}
	if chatFrames != 1 {
		t.Errorf("replay ring holds %d chat_message frames, want the one sequenced send", chatFrames)
	}
}

func payloadType(data []byte) string {
	var env struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(data, &env)
	return env.Type
}

// blockedBlockersReader holds ListBlockersOf, which only the channel_activity
// flush calls, until release is closed.
type blockedBlockersReader struct {
	VisibilityReader
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *blockedBlockersReader) ListBlockersOf(ctx context.Context, id int64) ([]int64, error) {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return r.VisibilityReader.ListBlockersOf(ctx, id)
	case <-ctx.Done():
		return nil, fmt.Errorf("blockers read: %w", ctx.Err())
	}
}

func startActivityHub(t *testing.T, h *Hub) {
	t.Helper()
	go h.Run()
	waitUntilRunning(t, h)
	t.Cleanup(func() {
		h.Stop()
		select {
		case <-h.Done():
		case <-time.After(5 * time.Second):
			t.Error("hub did not stop")
		}
	})
}

func TestChannelActivity_FlushOffDispatch(t *testing.T) {
	f := newActivityFixture(t)
	reader := f.user(t, "reader", permissions.MemberRoleID)
	watcher := f.user(t, "watcher", permissions.MemberRoleID)
	readerSend := f.connect(reader, 0)
	watcherSend := f.connect(watcher, f.textID)

	blocker := &blockedBlockersReader{
		VisibilityReader: f.hub.readers.Visibility,
		entered:          make(chan struct{}),
		release:          make(chan struct{}),
	}
	f.hub.readers.Visibility = blocker
	startActivityHub(t, f.hub)

	// The first mentioning send flushes at once and parks in the blockers read.
	var last atomic.Int64
	f.hub.activity.note(activityNote{channelID: f.textID, msgID: 1, authorID: f.author.ID, mentions: []int64{reader.ID}})
	select {
	case <-blocker.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the flush never reached its blockers read")
	}

	// Meanwhile senders race to note, and the dispatch goroutine keeps going.
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Go(func() {
			for i := range 10 {
				id := int64(100 + g*10 + i)
				f.hub.activity.note(activityNote{
					channelID: f.textID, msgID: id, authorID: f.author.ID, mentions: []int64{reader.ID},
				})
				for {
					cur := last.Load()
					if id <= cur || last.CompareAndSwap(cur, id) {
						break
					}
				}
			}
		})
	}
	wg.Wait()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("dispatch stalled behind the blocked flush: %v", err)
	}
	f.hub.BroadcastToAll(buildJSON(wsMsg{Type: "presence_update", Payload: map[string]any{"user_id": 99}}))
	f.hub.EmitEvents(ctx, []Event{channelEvt{evType: MsgTypeChatMessage, channelID: f.textID,
		payload: []byte(`{"type":"chat_message","payload":{"channel_id":1,"content":"live"}}`)}})
	if err := f.hub.awaitDispatch(ctx); err != nil {
		t.Fatalf("dispatch stalled: %v", err)
	}
	var sawPresence, sawChat bool
	for _, m := range drainChan(watcherSend, 100*time.Millisecond) {
		switch payloadType(m) {
		case "presence_update":
			sawPresence = true
		case MsgTypeChatMessage:
			sawChat = true
		}
	}
	if !sawPresence || !sawChat {
		t.Errorf("while the flush was blocked: presence delivered=%v, chat_message delivered=%v", sawPresence, sawChat)
	}

	close(blocker.release)

	// The notes made during the blocked flush are the next window's, not lost.
	var gotLast bool
	deadline := time.Now().Add(5 * time.Second)
	for !gotLast && time.Now().Before(deadline) {
		for _, frame := range activityFrames(readerSend) {
			for _, e := range frame {
				gotLast = gotLast || e.MessageID == last.Load()
			}
		}
	}
	if !gotLast {
		t.Fatalf("the latest message %d never reached the reader", last.Load())
	}
}

func TestChannelActivity_WindowThrottle(t *testing.T) {
	var a activityState
	t0 := time.Unix(1000, 0)
	if _, pending := a.due(t0); pending {
		t.Fatal("an empty state reports pending work")
	}

	a.note(activityNote{channelID: 1, msgID: 1, authorID: 9})
	if wait, pending := a.due(t0); !pending || wait != 0 {
		t.Fatalf("first note after a quiet period: wait=%v pending=%v, want 0 (leading edge)", wait, pending)
	}
	if got := a.take(t0); len(got) != 1 {
		t.Fatalf("take = %d channels, want 1", len(got))
	}

	a.note(activityNote{channelID: 1, msgID: 2, authorID: 9})
	if wait, _ := a.due(t0.Add(100 * time.Millisecond)); wait != 900*time.Millisecond {
		t.Errorf("100ms into the window: wait = %v, want 900ms", wait)
	}
	if wait, _ := a.due(t0.Add(activityWindow)); wait != 0 {
		t.Errorf("at the window's close: wait = %v, want 0", wait)
	}
	if got := a.take(t0.Add(activityWindow)); len(got) != 1 {
		t.Fatalf("second take = %d channels, want 1", len(got))
	}
	if got := a.take(t0.Add(2 * activityWindow)); got != nil {
		t.Errorf("take of an empty map = %v, want nil", got)
	}

	a.note(activityNote{channelID: 1, msgID: 3, authorID: 9})
	if wait, pending := a.due(t0.Add(5 * time.Second)); !pending || wait != 0 {
		t.Errorf("note after a quiet second: wait=%v pending=%v, want 0", wait, pending)
	}
}

func TestChannelActivity_MentionCapEvictsOldestByID(t *testing.T) {
	var a activityState
	a.note(activityNote{channelID: 1, msgID: 50, authorID: 9, mentions: []int64{2}})
	for id := int64(1); id < 20; id++ {
		a.note(activityNote{channelID: 1, msgID: id, authorID: 9, mentions: []int64{2}})
	}
	pc := a.pending[1]
	if len(pc.mentions) != activityMaxMentions {
		t.Fatalf("kept %d mentions, want %d", len(pc.mentions), activityMaxMentions)
	}
	lowest, kept50 := int64(1<<62), false
	for _, m := range pc.mentions {
		lowest = min(lowest, m.msgID)
		kept50 = kept50 || m.msgID == 50
	}
	if lowest != 5 || !kept50 || pc.latestID != 50 {
		t.Errorf("lowest kept id = %d, kept 50 = %v, latest = %d; want 5, true, 50", lowest, kept50, pc.latestID)
	}
}

func TestChannelActivity_ForgetDropsErasedUserAndSweptMessages(t *testing.T) {
	f := newActivityFixture(t)
	ctx := context.Background()
	a := f.user(t, "erased", permissions.MemberRoleID)
	b := f.user(t, "other", permissions.MemberRoleID)
	c := f.user(t, "reader", permissions.MemberRoleID)
	cSend := f.connect(c, 0)
	act := &f.hub.activity

	// A's mention is dropped; B's later message survives as the latest entry.
	act.note(activityNote{channelID: f.textID, msgID: 10, authorID: a.ID, mentions: []int64{c.ID}})
	act.note(activityNote{channelID: f.textID, msgID: 11, authorID: b.ID})
	act.forget([]int64{a.ID}, nil)
	f.flush()
	e := wantOneEntry(t, "after erasing A", activityFrames(cSend))
	if e.MessageID != 11 || e.AuthorID == nil || *e.AuthorID != b.ID || e.MentionsYou {
		t.Errorf("entry = %+v, want only B's message 11 with no mention", e)
	}

	// A swept latest message drops the whole channel.
	act.note(activityNote{channelID: f.textID, msgID: 30, authorID: b.ID})
	act.forget(nil, []int64{30})
	f.flush()
	if got := activityFrames(cSend); len(got) != 0 {
		t.Errorf("swept message still produced %+v", got)
	}

	// The real purge entry point reaches the pending map.
	startActivityHub(t, f.hub)
	act.mu.Lock()
	act.lastFlush = time.Now().Add(time.Hour)
	act.mu.Unlock()
	act.note(activityNote{channelID: f.textID, msgID: 40, authorID: a.ID, mentions: []int64{c.ID}})
	if err := f.hub.PurgeUserFromReplay(ctx, a.ID); err != nil {
		t.Fatalf("PurgeUserFromReplay: %v", err)
	}
	f.flush()
	if got := activityFrames(cSend); len(got) != 0 {
		t.Errorf("erased user's message still produced %+v", got)
	}
}

// markReadVia runs the real mark_read handler for u and emits its events.
func (f *activityFixture) markReadVia(t *testing.T, u *db.User, chID int64) {
	t.Helper()
	res := handleMarkReadV2(context.Background(), MarkReadCmd{userID: u.ID, ChannelID: chID},
		ClientInfo{UserID: u.ID, Username: u.Username}, PresenceDeps{ChannelSvc: f.svc.Channels})
	if res.Error != nil {
		t.Fatalf("mark_read: %v", res.Error)
	}
	f.hub.EmitEvents(context.Background(), res.Events)
}

func TestChannelActivity_MarkReadInWindowSuppresses(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	c := f.user(t, "c", permissions.MemberRoleID)
	bSend := f.connect(b, 0)
	cSend := f.connect(c, 0)

	_, m := f.send(t, f.author, f.textID, "hello")
	f.markReadVia(t, b, f.textID)
	f.flush()
	if got := activityFrames(bSend); len(got) != 0 {
		t.Errorf("b marked the channel read in the window but got %+v", got)
	}
	if e := wantOneEntry(t, "c", activityFrames(cSend)); e.MessageID != m {
		t.Errorf("c entry = %+v, want message %d", e, m)
	}

	// A message noted after the mark is still delivered to b.
	_, m2 := f.send(t, f.author, f.textID, "later")
	f.flush()
	if e := wantOneEntry(t, "b after", activityFrames(bSend)); e.MessageID != m2 {
		t.Errorf("b entry = %+v, want message %d", e, m2)
	}
}

func TestChannelActivity_FocusInWindowSuppresses(t *testing.T) {
	f := newActivityFixture(t)
	b := f.user(t, "b", permissions.MemberRoleID)
	bSend := f.connect(b, 0)

	f.send(t, f.author, f.textID, "hello")
	res := handleChannelFocusV2(context.Background(), ChannelFocusCmd{ChannelID: f.textID},
		ClientInfo{UserID: b.ID, Username: b.Username}, PresenceDeps{ChannelSvc: f.svc.Channels})
	if res.SetChannelID == nil {
		t.Fatalf("focus did not apply: %+v", res)
	}
	f.hub.EmitEvents(context.Background(), res.Events)
	f.flush()
	if got := activityFrames(bSend); len(got) != 0 {
		t.Errorf("b opened the channel in the window but got %+v", got)
	}
}

func TestChatSend_ReplyPingReachesMentionsAndActivity(t *testing.T) {
	f := newActivityFixture(t)
	parentAuthor := f.user(t, "parent", permissions.MemberRoleID)
	parentID, err := f.db.CreateMessage(context.Background(), f.textID, parentAuthor.ID, "the parent", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	// The parent author is connected without the channel focused, so only the
	// channel_activity path can reach them.
	parentSend := f.connect(parentAuthor, 0)

	res := handleChatSendV2(context.Background(),
		ChatSendCmd{ChannelID: f.textID, Content: "agreed", ReplyTo: &parentID, ReplyPing: true},
		ClientInfo{UserID: f.author.ID, Username: f.author.Username, RoleName: "owner"},
		ChatDeps{Limiter: f.hub.limiter, MessageSvc: f.svc.Messages, LiveStatus: f.hub.LiveStatus})
	if res.Error != nil {
		t.Fatalf("chat_send: %v", res.Error)
	}
	f.hub.EmitEvents(context.Background(), res.Events)
	f.flush()

	// The chat_message frame is the channel event the handler returned.
	var mentions []int64
	for _, ev := range res.Events {
		if ev.EventType() != MsgTypeChatMessage {
			continue
		}
		var env struct {
			Payload struct {
				Mentions []int64 `json:"mentions"`
			} `json:"payload"`
		}
		ce, ok := ev.(ChannelEvent)
		if !ok || json.Unmarshal(ce.Payload(), &env) != nil {
			t.Fatalf("chat_message event %T has no readable payload", ev)
		}
		mentions = env.Payload.Mentions
	}
	if len(mentions) != 1 || mentions[0] != parentAuthor.ID {
		t.Errorf("chat_message.mentions = %v, want [%d]", mentions, parentAuthor.ID)
	}
	if e := wantOneEntry(t, "parent author", activityFrames(parentSend)); !e.MentionsYou {
		t.Errorf("parent author entry = %+v, want mentions_you", e)
	}
}
