package ws

// presence_batch_test.go — P5-S03: connect/disconnect presence rides one
// presence_batch per coalescing window, a presence frame that finds the
// normal queue full is dropped (the client is marked stale and gets a full
// snapshot) instead of kicking the client, and member_join data is sent only
// for a member other clients do not have yet.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type batchFrame struct {
	Type    string `json:"type"`
	Payload struct {
		Updates []struct {
			UserID       int64              `json:"user_id"`
			Status       string             `json:"status"`
			CustomStatus *string            `json:"custom_status"`
			Member       *memberUserPayload `json:"member"`
		} `json:"updates"`
		Full bool `json:"full"`
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
	h := newTestHub(t, database, nil, nil)
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
		c.setLiveStatus(db.StatusOnline)
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

func TestFreshConnect_FirstEverConnectFoldsMemberIntoBatch(t *testing.T) {
	h, _, connect := presenceBatchHub(t)
	observer := connect("observer", true)
	settle(t, h)
	drain(observer.send)

	newcomer := connect("newcomer", false) // never connected: last_seen is NULL
	h.announceFreshConnect(newcomer)
	settle(t, h)

	frames := decodeFrames(t, drain(observer.send))
	if len(frames) != 1 || frames[0].Type != MsgTypePresenceBatch {
		t.Fatalf("observer got %+v, want exactly one presence_batch", frames)
	}
	u := frames[0].Payload.Updates
	if len(u) != 1 || u[0].Member == nil || u[0].Member.ID != newcomer.userID || u[0].Member.Username != "newcomer" {
		t.Fatalf("batch updates = %+v, want the newcomer with member data", u)
	}
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

	ghost.setLiveStatus(db.StatusInvisible)
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
	if got[slow.userID] != db.StatusOnline || got[ghost.userID] != db.StatusOffline {
		t.Fatalf("snapshot = %v, want self online and the invisible ghost offline", got)
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
