package ws

// presence_batch_test.go — P5-S03: connect/disconnect presence rides one
// presence_batch per coalescing window, a presence frame that finds the
// normal queue full is dropped (the client is marked stale and gets a full
// snapshot) instead of kicking the client, and a member_join is sent only
// for a member other clients do not have yet.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

type batchFrame struct {
	Type    string `json:"type"`
	Payload struct {
		Updates []struct {
			UserID       int64            `json:"user_id"`
			Status       string           `json:"status"`
			CustomStatus *string          `json:"custom_status"`
			Member       *json.RawMessage `json:"member"`
		} `json:"updates"`
		Full bool              `json:"full"`
		User memberUserPayload `json:"user"`
	} `json:"payload"`
}

func decodeFrames(t *testing.T, frames [][]byte) []batchFrame {
	t.Helper()
	out := make([]batchFrame, 0, len(frames))
	for _, raw := range frames {
		var f batchFrame
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		out = append(out, f)
	}
	return out
}

// presenceBatchHub is a running hub with two registered, headless clients.
func presenceBatchHub(t *testing.T) (*Hub, *db.DB, func(name string, seen bool) *Client) {
	t.Helper()
	database := newTeardownTestDB(t)
	limiter := auth.NewRateLimiter()
	h := newTestHub(t, database, limiter, service.New(database, limiter))
	go h.Run()
	t.Cleanup(h.Stop)
	ctx := context.Background()
	connect := func(name string, seen bool) *Client {
		id, err := database.CreateUser(ctx, name, "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		if seen {
			if err := database.UpdateUserStatus(ctx, id, db.StatusOffline); err != nil {
				t.Fatalf("UpdateUserStatus: %v", err)
			}
		}
		u, err := database.GetUserByID(ctx, id)
		if err != nil {
			t.Fatalf("GetUserByID: %v", err)
		}
		c := herdClient(ctx, h, u)
		h.registerNow(c, nil)
		c.user.Status = db.StatusOnline
		c.setLivePresence(db.StatusOnline, nil)
		return c
	}
	return h, database, connect
}

// settle waits out a coalescing window and every dispatch queued before it.
func settle(t *testing.T, h *Hub) {
	t.Helper()
	time.Sleep(presenceCoalesceWindow + 100*time.Millisecond)
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatalf("awaitDispatch: %v", err)
	}
}

func TestFreshConnect_ExistingMemberSendsNoMemberJoin(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	observer := connect("observer", true)
	settle(t, h)
	drain(observer.send)

	returning := connect("returning", true)
	h.announceFreshConnect(returning)
	settle(t, h)

	frames := decodeFrames(t, drain(observer.send))
	if len(frames) != 1 || frames[0].Type != MsgTypePresenceBatch {
		t.Fatalf("observer got %+v, want exactly one presence_batch", frames)
	}
	u := frames[0].Payload.Updates
	if len(u) != 1 || u[0].UserID != returning.userID || u[0].Status != db.StatusOnline || u[0].Member != nil {
		t.Fatalf("batch updates = %+v, want the returning member online with no member data", u)
	}
}

// wantMemberJoinThenBatch asserts frames are the newcomer's member_join
// followed by a presence_batch entry for them with no member data.
func wantMemberJoinThenBatch(t *testing.T, frames []batchFrame, newcomer *Client) {
	t.Helper()
	if len(frames) != 2 || frames[0].Type != MsgTypeMemberJoin || frames[1].Type != MsgTypePresenceBatch {
		t.Fatalf("observer got %+v, want member_join then presence_batch", frames)
	}
	if u := frames[0].Payload.User; u.ID != newcomer.userID || u.Username != newcomer.user.Username {
		t.Fatalf("member_join user = %+v, want the newcomer", u)
	}
	u := frames[1].Payload.Updates
	if len(u) != 1 || u[0].UserID != newcomer.userID || u[0].Member != nil {
		t.Fatalf("batch updates = %+v, want the newcomer's presence with no member data", u)
	}
}

func TestFreshConnect_FirstEverConnectSendsMemberJoinAheadOfBatch(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	observer := connect("observer", true)
	settle(t, h)
	drain(observer.send)

	newcomer := connect("newcomer", false) // never connected: last_seen is NULL
	h.applyConnectStatus(context.Background(), newcomer)
	h.announceFreshConnect(newcomer)
	settle(t, h)

	wantMemberJoinThenBatch(t, decodeFrames(t, drain(observer.send)), newcomer)
}

func TestFreshConnect_FailedFirstHandshakeStillAnnouncesOnNextConnect(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	ctx := context.Background()
	observer := connect("observer", true)

	// The first-ever connect stamps last_seen, then its handshake fails
	// before the announce.
	first := connect("newcomer", false)
	h.applyConnectStatus(ctx, first)
	h.unregisterFailedHandshake(ctx, first)
	settle(t, h)
	drain(observer.send)

	reconnect := func() *Client {
		u, err := database.GetUserByID(ctx, first.userID)
		if err != nil || u.LastSeen == nil {
			t.Fatalf("GetUserByID = %+v, %v; want last_seen stamped", u, err)
		}
		c := herdClient(ctx, h, u)
		h.registerNow(c, nil)
		h.applyConnectStatus(ctx, c)
		h.announceFreshConnect(c)
		settle(t, h)
		return c
	}
	second := reconnect()
	wantMemberJoinThenBatch(t, decodeFrames(t, drain(observer.send)), second)

	// Announced once, the next connect is presence only.
	h.unregisterFailedHandshake(ctx, second)
	settle(t, h)
	drain(observer.send)
	reconnect()
	for _, f := range decodeFrames(t, drain(observer.send)) {
		if f.Type != MsgTypePresenceBatch {
			t.Fatalf("a connect after the member was announced sent %s", f.Type)
		}
	}
}

// A herd window that carries a new member still leaves every presence frame
// droppable: a slow client gets the newcomer's member_join and drops the
// batch, and is marked stale rather than kicked.
func TestPresenceHerd_WindowWithNewMemberKicksNoSlowClient(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	slow := connect("slow", true)
	settle(t, h)
	drain(slow.send)

	returning := make([]*Client, 20)
	for i := range returning {
		returning[i] = connect(fmt.Sprintf("returning-%02d", i), true)
	}
	newcomer := connect("newcomer", false)
	h.applyConnectStatus(context.Background(), newcomer)
	drain(slow.send)
	for len(slow.send) < cap(slow.send)-1 {
		slow.send <- []byte(`{"type":"filler"}`)
	}
	for _, c := range append(returning, newcomer) {
		h.announceFreshConnect(c)
	}
	settle(t, h)

	if slow.isSendClosed() || h.bpQueueDisconnects.Load() != 0 {
		t.Fatalf("a herd window with a new member kicked a slow client (disconnects = %d)", h.bpQueueDisconnects.Load())
	}
	if !slow.presenceStale.Load() {
		t.Fatal("the slow client's batch was not dropped as presence")
	}
	frames := drain(slow.send)
	last := decodeFrames(t, frames[len(frames)-1:])[0]
	if last.Type != MsgTypeMemberJoin || last.Payload.User.ID != newcomer.userID {
		t.Fatalf("the slow client's last frame = %s, want the newcomer's member_join", frames[len(frames)-1])
	}
}

// A window batch or snapshot request the full dispatch queue refuses is not
// lost: every connected client is marked stale, and the snapshot request is
// retried until one gets through.
func TestPresenceBatch_LostAtEnqueueRepairsBySnapshot(t *testing.T) {
	database := newTeardownTestDB(t)
	h := newTestHub(t, database, nil, nil)
	ctx := context.Background()
	id, err := database.CreateUser(ctx, "watcher", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	u, err := database.GetUserByID(ctx, id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	watcher := herdClient(ctx, h, u)
	h.registerNow(watcher, nil)
	watcher.setLivePresence(db.StatusOnline, nil)

	for len(h.broadcast) < cap(h.broadcast) {
		h.broadcast <- broadcastMsg{}
	}
	h.QueuePresence(id+1, db.StatusOnline, nil)
	h.flushPresenceQueue()
	if !watcher.presenceStale.Load() {
		t.Fatal("a presence_batch lost at enqueue left the connected client unmarked")
	}

	for len(h.broadcast) > 0 {
		<-h.broadcast
	}
	go h.Run()
	t.Cleanup(h.Stop)
	settle(t, h)

	for _, f := range decodeFrames(t, drain(watcher.send)) {
		if f.Type == MsgTypePresenceBatch && f.Payload.Full {
			return
		}
	}
	t.Fatal("the lost batch was never repaired by a full snapshot")
}

func TestPresenceBatch_InvisibleEntryIsOfflineToOthersTrueToSelf(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ghost := connect("ghost", true)
	other := connect("other", true)

	text := "heads down"
	h.QueuePresence(ghost.userID, db.StatusInvisible, &text)
	h.QueuePresence(other.userID, db.StatusOnline, nil)
	settle(t, h)

	for _, tc := range []struct {
		c          *Client
		wantStatus string
		wantText   *string
	}{
		{other, db.StatusOffline, nil},
		{ghost, db.StatusInvisible, &text},
	} {
		frames := decodeFrames(t, drain(tc.c.send))
		if len(frames) != 1 || frames[0].Type != MsgTypePresenceBatch {
			t.Fatalf("user %d got %+v, want one presence_batch", tc.c.userID, frames)
		}
		found := false
		for _, e := range frames[0].Payload.Updates {
			if e.UserID != ghost.userID {
				continue
			}
			found = true
			if e.Status != tc.wantStatus {
				t.Errorf("user %d sees ghost as %q, want %q", tc.c.userID, e.Status, tc.wantStatus)
			}
			if (e.CustomStatus == nil) != (tc.wantText == nil) || (e.CustomStatus != nil && *e.CustomStatus != *tc.wantText) {
				t.Errorf("user %d sees ghost custom_status %v, want %v", tc.c.userID, e.CustomStatus, tc.wantText)
			}
		}
		if !found {
			t.Fatalf("user %d's batch has no entry for the ghost", tc.c.userID)
		}
	}
}

// fillQueue leaves c's normal queue full.
func fillQueue(c *Client) {
	for len(c.send) < cap(c.send) {
		c.send <- []byte(`{"type":"filler"}`)
	}
}

func TestPresenceFrame_FullQueueDropsAndMarksStale_ContentFrameStillCloses(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	slow := connect("slow", true)
	mover := connect("mover", true)
	settle(t, h)
	drain(slow.send)
	fillQueue(slow)

	// A window batch and a single status change, both into a full queue.
	h.QueuePresence(mover.userID, db.StatusIdle, nil)
	settle(t, h)
	h.EmitEvents(context.Background(), presenceEvents(mover.userID, db.StatusDND, nil))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if slow.isSendClosed() {
		t.Fatal("a presence frame into a full queue closed the client")
	}
	if got := h.bpQueueDisconnects.Load(); got != 0 {
		t.Fatalf("backpressure_queue_disconnects = %d, want 0", got)
	}
	if !slow.presenceStale.Load() {
		t.Fatal("the client that dropped presence is not marked stale")
	}

	// Content frames keep today's policy.
	h.BroadcastToAll(buildChannelDelete(99))
	if err := h.awaitDispatch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !slow.isSendClosed() {
		t.Fatal("a content frame into a full queue did not close the client")
	}
}

func TestPresenceStale_NextWindowSendsFullSnapshot(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	slow := connect("slow", true)
	ghost := connect("ghost", true)
	settle(t, h)
	drain(slow.send)
	fillQueue(slow)

	ghost.setLivePresence(db.StatusInvisible, nil)
	h.QueuePresence(ghost.userID, db.StatusInvisible, nil)
	settle(t, h)
	drain(slow.send) // the reader catches up
	settle(t, h)

	var snap *batchFrame
	for _, f := range decodeFrames(t, drain(slow.send)) {
		if f.Type == MsgTypePresenceBatch && f.Payload.Full {
			snap = &f
		}
	}
	if snap == nil {
		t.Fatal("a stale client got no full presence snapshot")
	}
	got := map[int64]string{}
	for _, e := range snap.Payload.Updates {
		got[e.UserID] = e.Status
	}
	if _, listed := got[ghost.userID]; got[slow.userID] != db.StatusOnline || listed {
		t.Fatalf("snapshot = %v, want self online and the invisible ghost left out", got)
	}
	if slow.presenceStale.Load() {
		t.Fatal("the snapshot did not clear the stale mark")
	}
}

func TestPresenceDrop_ForcesFullReadyOnResume(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	slow := connect("slow", true)
	mover := connect("mover", true)
	settle(t, h)
	drain(slow.send)
	fillQueue(slow)

	h.QueuePresence(mover.userID, db.StatusIdle, nil)
	settle(t, h)

	resume := func(u *db.User) bool {
		c := herdClient(context.Background(), h, u)
		c.lastSeq = h.ReplayBuffer().NewestSeq()
		_, _, ok := h.reconnectPrecheck(context.Background(), c, c.lastSeq)
		return ok
	}
	if !resume(mover.user) {
		t.Fatal("control: a resume with no dropped presence was refused replay")
	}
	if resume(slow.user) {
		t.Fatal("a resume after a dropped presence frame took replay, want the full ready")
	}
}

func TestPresenceBatch_ErasedUserLosesOnlyItsOwnEntry(t *testing.T) {
	h := &Hub{purgedUsers: map[int64]struct{}{7: {}}}
	msg, _ := h.buildPresenceBatch(map[int64]pendingPresence{7: {status: db.StatusOffline}, 8: {status: db.StatusOnline}})
	if msg == nil || eventNamesUser(msg, 7) || !eventNamesUser(msg, 8) {
		t.Fatalf("batch = %s, want user 8's entry kept and the erased user 7's dropped", msg)
	}
	if msg, _ := h.buildPresenceBatch(map[int64]pendingPresence{7: {status: db.StatusOffline}}); msg != nil {
		t.Fatalf("a batch naming only an erased user = %s, want none", msg)
	}
}

func TestPresenceUpdate_InsideTheWindowStillDeliversTheNewMember(t *testing.T) {
	h := &Hub{broadcast: make(chan broadcastMsg, 8)}
	m := memberUserPayload{ID: 9, Username: "newcomer"}
	h.queuePresence(9, pendingPresence{status: db.StatusOnline, member: &m})
	h.QueuePresence(9, db.StatusOnline, nil) // a later state keeps the member data
	h.presenceMu.Lock()
	kept := h.presenceQueue[9].member != nil
	h.presenceMu.Unlock()
	if !kept {
		t.Fatal("a later state in the window lost the member data")
	}

	h.EmitEvents(context.Background(), presenceEvents(9, db.StatusDND, nil))
	if len(h.broadcast) != 2 {
		t.Fatalf("got %d frames, want member_join then the fresher presence", len(h.broadcast))
	}
	if first := <-h.broadcast; !strings.Contains(string(first.msg), `"type":"member_join"`) || !strings.Contains(string(first.msg), `"newcomer"`) {
		t.Fatalf("first frame = %s, want the newcomer's member_join", first.msg)
	}
	if second := <-h.broadcast; !strings.Contains(string(second.msg), `"status":"dnd"`) {
		t.Fatalf("second frame = %s, want the fresher presence", second.msg)
	}
}

// queuedFrame is the frame a queued broadcast will carry: a presence window
// is built at dispatch time, everything else is built at enqueue.
func queuedFrame(h *Hub, bm broadcastMsg) []byte {
	if bm.presence != nil {
		msg, _ := h.buildPresenceBatch(bm.presence)
		return msg
	}
	return bm.msg
}

// fullSnapshot returns the statuses in the last full presence_batch on c.
func fullSnapshot(t *testing.T, c *Client) map[int64]string {
	t.Helper()
	var got map[int64]string
	for _, f := range decodeFrames(t, drain(c.send)) {
		if f.Type == MsgTypePresenceBatch && f.Payload.Full {
			got = map[int64]string{}
			for _, e := range f.Payload.Updates {
				got[e.UserID] = e.Status
			}
		}
	}
	if got == nil {
		t.Fatalf("user %d got no full presence snapshot", c.userID)
	}
	return got
}

func TestPresenceSnapshot_InvisibleIsIndistinguishableFromOffline(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	ctx := context.Background()
	observer := connect("observer", true)
	ghost := connect("ghost", true)
	ghost.setLivePresence(db.StatusInvisible, nil)
	away, err := database.CreateUser(ctx, "away", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	settle(t, h)
	drain(observer.send)
	drain(ghost.send)

	observer.presenceStale.Store(true)
	ghost.presenceStale.Store(true)
	h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot")
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}

	seen := fullSnapshot(t, observer)
	_, ghostListed := seen[ghost.userID]
	_, awayListed := seen[away]
	if ghostListed != awayListed || seen[ghost.userID] != seen[away] {
		t.Fatalf("observer's snapshot = %v: the connected invisible user %d reads differently from the offline user %d", seen, ghost.userID, away)
	}
	if own := fullSnapshot(t, ghost); own[ghost.userID] != db.StatusInvisible {
		t.Fatalf("the ghost's own snapshot = %v, want its true invisible status", own)
	}
}

// A presence_batch lost at enqueue consumed no seq, so replay cannot carry
// it: a resume from before the loss must take the full ready.
func TestPresenceBatch_LostAtEnqueueForcesFullReadyOnResume(t *testing.T) {
	database := newTeardownTestDB(t)
	h := newTestHub(t, database, nil, nil)
	ctx := context.Background()
	id, err := database.CreateUser(ctx, "away", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	u, err := database.GetUserByID(ctx, id)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	h.deliverBroadcast(broadcastMsg{msg: buildChannelDelete(98)})
	lastSeq := h.ReplayBuffer().NewestSeq()

	for len(h.broadcast) < cap(h.broadcast) {
		h.broadcast <- broadcastMsg{}
	}
	h.QueuePresence(id+1, db.StatusOnline, nil)
	h.flushPresenceQueue()
	for len(h.broadcast) > 0 {
		<-h.broadcast
	}
	h.deliverBroadcast(broadcastMsg{msg: buildChannelDelete(99)})

	c := herdClient(ctx, h, u)
	c.lastSeq = lastSeq
	if _, _, ok := h.reconnectPrecheck(ctx, c, lastSeq); ok {
		t.Fatal("a resume from before a lost presence_batch took replay, want the full ready")
	}
}

// fullSnapshotTexts returns the custom_status of each entry in the last full
// presence_batch on c.
func fullSnapshotTexts(t *testing.T, c *Client) map[int64]*string {
	t.Helper()
	var got map[int64]*string
	for _, f := range decodeFrames(t, drain(c.send)) {
		if f.Type == MsgTypePresenceBatch && f.Payload.Full {
			got = map[int64]*string{}
			for _, e := range f.Payload.Updates {
				got[e.UserID] = e.CustomStatus
			}
		}
	}
	if got == nil {
		t.Fatalf("user %d got no full presence snapshot", c.userID)
	}
	return got
}

func TestPresenceSnapshot_RepairsADroppedCustomStatus(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ctx := context.Background()
	slow := connect("slow", true)
	mover := connect("mover", true)
	settle(t, h)
	drain(slow.send)
	fillQueue(slow)

	h.handleMessage(mover, []byte(`{"type":"presence_update","payload":{"status":"online","custom_status":"lunch"}}`))
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}
	if !slow.presenceStale.Load() {
		t.Fatal("the custom status change was not dropped as presence")
	}
	drain(slow.send) // the reader catches up
	settle(t, h)

	if got := fullSnapshotTexts(t, slow)[mover.userID]; got == nil || *got != "lunch" {
		t.Fatalf("snapshot custom_status for the mover = %v, want \"lunch\"", got)
	}
}

func TestPresenceSnapshot_InvisibleTextOnlyToSelf(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	ctx := context.Background()
	observer := connect("observer", true)
	ghost := connect("ghost", true)
	text := "heads down"
	ghost.setLivePresence(db.StatusInvisible, &text)
	settle(t, h)
	drain(observer.send)
	drain(ghost.send)

	observer.presenceStale.Store(true)
	ghost.presenceStale.Store(true)
	h.enqueue(broadcastMsg{presenceSnapshot: true}, "presence snapshot")
	if err := h.awaitDispatch(ctx); err != nil {
		t.Fatal(err)
	}

	if seen := fullSnapshotTexts(t, observer); seen[ghost.userID] != nil {
		t.Fatalf("observer's snapshot carries the invisible user's text %q", *seen[ghost.userID])
	}
	if own := fullSnapshotTexts(t, ghost)[ghost.userID]; own == nil || *own != text {
		t.Fatalf("the ghost's own snapshot custom_status = %v, want %q", own, text)
	}
}
