package ws

// member_timeouts_race_internal_test.go — the member_timeouts view against
// role changes that land mid-delivery (WP 3C-7c): a publish whose audience
// was resolved before a revoke, a fresh connect whose ready was built before
// a grant or revoke, and a replaying resume whose old connection is gone.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// setTimeoutViewResolvedHook installs fn as timeoutViewResolvedHook for the
// test, running it once: the role refresh fn triggers resolves verdicts too
// and re-enters the hook.
func setTimeoutViewResolvedHook(t *testing.T, fn func()) {
	t.Helper()
	var fired atomic.Bool
	timeoutViewResolvedHook = func() {
		if fired.CompareAndSwap(false, true) {
			fn()
		}
	}
	t.Cleanup(func() { timeoutViewResolvedHook = nil })
}

func setReadyTimeoutsCommitHook(t *testing.T, fn func()) {
	t.Helper()
	var fired atomic.Bool
	readyTimeoutsCommitHook = func() {
		if fired.CompareAndSwap(false, true) {
			fn()
		}
	}
	t.Cleanup(func() { readyTimeoutsCommitHook = nil })
}

// changeRole moves userID to roleID the way the admin handlers do: commit,
// invalidate the cached permissions, then re-derive visibility.
func changeRole(t *testing.T, f *timeoutViewFixture, userID, roleID int64) {
	t.Helper()
	if err := f.database.UpdateUserRole(context.Background(), userID, roleID); err != nil {
		t.Fatalf("UpdateUserRole: %v", err)
	}
	f.hub.perms.InvalidateUser(userID)
	f.hub.RefreshAllChannelVisibility()
}

// A revoke that completes between a publish's audience resolution and its
// sends: the publish resolves again, so the demoted moderator's last frame is
// its own-only list and its flag is down.
func TestPublishMemberTimeouts_RevokeAfterResolve_SendsOwnOnly(t *testing.T) {
	f := roleChangeFixture(t)
	f.hub.ClientForTest(f.modID).timeouts.full.Store(true) // as its ready set it
	setTimeoutViewResolvedHook(t, func() { changeRole(t, f, f.modID, 4) })

	f.hub.publishMemberTimeouts(f.targetID)

	fr := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond))
	if len(fr) == 0 || len(fr[len(fr)-1]) != 0 {
		t.Fatalf("demoted moderator frames = %v, want the last one own-only (empty)", fr)
	}
	if f.hub.ClientForTest(f.modID).timeouts.full.Load() {
		t.Error("timeouts.full still set on the demoted moderator")
	}
	// The remaining moderator still ends on the full list.
	fr = timeoutFrames(t, drainChan(f.sends[f.adminID], 100*time.Millisecond))
	if len(fr) == 0 || !reflect.DeepEqual(entryIDs(fr[len(fr)-1]), []int64{f.targetID}) {
		t.Errorf("administrator frames = %v, want the last one to list the target", fr)
	}
}

// A connection that replaced the evaluated one before the sends (a resume)
// receives the frame; the replaced connection does not.
func TestPublishMemberTimeouts_ReplacedClientGetsFrame(t *testing.T) {
	f := roleChangeFixture(t)
	oldSend := f.sends[f.modID]
	var newSend chan []byte
	setTimeoutViewResolvedHook(t, func() {
		f.hub.mu.Lock()
		newSend = registerEmitTestClient(f.hub, f.modID, 0)
		f.hub.mu.Unlock()
	})

	f.hub.publishMemberTimeouts(f.targetID)

	if fr := timeoutFrames(t, drainChan(newSend, 100*time.Millisecond)); len(fr) != 1 ||
		!reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
		t.Errorf("replacement connection frames = %v, want the full list", fr)
	}
	if fr := timeoutFrames(t, drainChan(oldSend, 100*time.Millisecond)); len(fr) != 0 {
		t.Errorf("replaced connection got %v, want nothing", fr)
	}
}

// Role refreshes keep moving the counter across several resolutions, then a
// refresh runs in the next window and sends moderators the full list: the
// publish keeps resolving until the counter holds still and never narrows a
// current moderator's list.
func TestPublishMemberTimeouts_RepeatedRoleRefreshes_ModeratorsKeepFullList(t *testing.T) {
	f := roleChangeFixture(t)
	for _, id := range []int64{f.adminID, f.modID} {
		f.hub.ClientForTest(id).timeouts.full.Store(true)
	}
	var calls atomic.Int32
	timeoutViewResolvedHook = func() {
		switch n := calls.Add(1); {
		case n <= 3:
			f.hub.bumpTimeoutViewGen()
		case n == 4:
			f.hub.RefreshAllChannelVisibility() // its own resolution re-enters this hook
		}
	}
	t.Cleanup(func() { timeoutViewResolvedHook = nil })

	f.hub.publishMemberTimeouts(f.targetID)

	for _, id := range []int64{f.adminID, f.modID} {
		fr := timeoutFrames(t, drainChan(f.sends[id], 100*time.Millisecond))
		if len(fr) == 0 || !reflect.DeepEqual(entryIDs(fr[len(fr)-1]), []int64{f.targetID}) {
			t.Errorf("moderator %d frames = %v, want the last one to be the full list", id, fr)
		}
		if !f.hub.ClientForTest(id).timeouts.full.Load() {
			t.Errorf("moderator %d not flagged full", id)
		}
	}
	fr := timeoutFrames(t, drainChan(f.sends[f.targetID], 100*time.Millisecond))
	if len(fr) == 0 || !reflect.DeepEqual(entryIDs(fr[len(fr)-1]), []int64{f.targetID}) {
		t.Errorf("target frames = %v, want its own entry last", fr)
	}
	if n := calls.Load(); n < 5 {
		t.Errorf("hook ran %d times, want the publish to resolve again after the refresh", n)
	}
}

// A moderator whose verdict lookup fails during a role refresh is skipped:
// it keeps the full list it holds instead of being narrowed to its own entry.
func TestRoleRefresh_VerdictLookupError_LeavesModeratorAlone(t *testing.T) {
	f := roleChangeFixture(t)
	f.hub.ClientForTest(f.modID).timeouts.full.Store(true) // as its ready set it
	timeoutVerdictLookupHook = func(userID int64) error {
		if userID == f.modID {
			return errors.New("injected lookup failure")
		}
		return nil
	}
	t.Cleanup(func() { timeoutVerdictLookupHook = nil })

	changeRole(t, f, f.byID, 3) // an unrelated grant triggers the refresh

	if fr := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond)); len(fr) != 0 {
		t.Errorf("moderator with an unknown verdict got %v, want nothing", fr)
	}
	if !f.hub.ClientForTest(f.modID).timeouts.full.Load() {
		t.Error("timeouts.full cleared on a moderator whose verdict was unknown")
	}
	// The refresh still reached the user it could evaluate.
	if fr := timeoutFrames(t, drainChan(f.sends[f.byID], 100*time.Millisecond)); len(fr) != 1 ||
		!reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
		t.Errorf("newly granted moderator frames = %v, want the full list", fr)
	}
}

// With the timeout mirror unloaded, the publish reloads it and delivers
// instead of skipping.
func TestPublishMemberTimeouts_UnloadedMirror_ReloadsAndSends(t *testing.T) {
	f := roleChangeFixture(t)
	// Verdict resolution itself loads the mirror, so swap in a service whose
	// mirror is unloaded right before the send step reads it.
	setTimeoutViewResolvedHook(t, func() {
		f.hub.perms = service.NewPermissionService(f.database, permissions.NewChecker(f.database))
		if _, ok := f.hub.perms.TimeoutSnapshot(); ok {
			t.Error("precondition: a new PermissionService should start with the mirror unloaded")
		}
	})

	f.hub.publishMemberTimeouts(f.targetID)

	if fr := timeoutFrames(t, drainChan(f.sends[f.modID], 100*time.Millisecond)); len(fr) != 1 ||
		!reflect.DeepEqual(entryIDs(fr[0]), []int64{f.targetID}) {
		t.Errorf("moderator frames = %v, want the full list after the reload", fr)
	}
}

// timeoutDialFixture is a running hub behind a real ServeWS listener, with
// the timeout target's ledger row written directly (no publish, so the
// visibility watermark stays put and a resume can replay).
type timeoutDialFixture struct {
	*timeoutViewFixture
	url    string
	chID   int64
	tokens map[int64]string
}

func newTimeoutDialFixture(t *testing.T) *timeoutDialFixture {
	t.Helper()
	database := newTeardownTestDB(t)
	ctx := context.Background()
	f := &timeoutViewFixture{database: database, sends: map[int64]chan []byte{}}
	d := &timeoutDialFixture{timeoutViewFixture: f, tokens: map[int64]string{}}
	mk := func(name string, role int) int64 {
		id, err := database.CreateUser(ctx, name, "hash", role)
		if err != nil {
			t.Fatalf("CreateUser %s: %v", name, err)
		}
		token, err := auth.GenerateToken()
		if err != nil {
			t.Fatalf("GenerateToken: %v", err)
		}
		if _, err := database.CreateSession(ctx, id, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
		d.tokens[id] = token
		return id
	}
	f.adminID = mk("td-admin", 1)
	f.modID = mk("td-mod", 3)
	f.targetID = mk("td-target", 4)
	f.byID = mk("td-bystander", 4)
	chID, err := database.CreateChannel(ctx, "td-channel", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	d.chID = chID
	if _, _, err := database.TimeoutUser(ctx, f.targetID, f.adminID, nil, "cool off", time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("TimeoutUser: %v", err)
	}
	f.hub = newTestHub(t, database, auth.NewRateLimiter(), nil)
	f.hub.perms = service.NewPermissionService(database, permissions.NewChecker(database))
	if err := f.hub.perms.RefreshTimeouts(ctx); err != nil {
		t.Fatalf("RefreshTimeouts: %v", err)
	}
	go f.hub.Run()
	t.Cleanup(f.hub.Stop)
	srv := httptest.NewServer(ServeWS(f.hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	d.url = "ws" + strings.TrimPrefix(srv.URL, "http")
	return d
}

// dial authenticates userID (resuming from lastSeq when non-zero) and returns
// the open connection with every frame received until the line goes idle.
func (d *timeoutDialFixture) dial(t *testing.T, userID int64, lastSeq uint64) (<-chan []byte, [][]byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, d.url, nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	conn.SetReadLimit(-1)
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	payload := map[string]any{"token": d.tokens[userID]}
	if lastSeq > 0 {
		payload["last_seq"] = lastSeq
	}
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	// A Read whose context expires closes the connection, so one reader
	// owns it for the test's lifetime and hands frames over a channel.
	readCtx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	inbox := make(chan []byte, 256)
	go func() {
		defer close(inbox)
		for {
			_, msg, err := conn.Read(readCtx)
			if err != nil {
				return
			}
			select {
			case inbox <- msg:
			case <-readCtx.Done():
				return
			}
		}
	}()
	return inbox, readUntilIdle(inbox)
}

// readUntilIdle returns the frames that arrive on inbox until it has been
// quiet for half a second.
func readUntilIdle(inbox <-chan []byte) [][]byte {
	var frames [][]byte
	for {
		select {
		case msg, ok := <-inbox:
			if !ok {
				return frames
			}
			frames = append(frames, msg)
		case <-time.After(500 * time.Millisecond):
			return frames
		}
	}
}

// liveClient returns userID's registered client, failing the test if none.
func liveClient(t *testing.T, h *Hub, userID int64) *Client {
	t.Helper()
	c := h.ClientForTest(userID)
	if c == nil {
		t.Fatalf("user %d has no registered client", userID)
	}
	return c
}

// heldTimeoutList replays frames the way a client applies them: ready's
// member_timeouts, then each member_timeouts frame replacing it. ok is false
// when no frame carried the view.
func heldTimeoutList(t *testing.T, frames [][]byte) (held []int64, ok bool) {
	t.Helper()
	for _, m := range frames {
		var env struct {
			Type    string `json:"type"`
			Payload struct {
				Ready    *[]memberTimeoutEntry `json:"member_timeouts"`
				Timeouts *[]memberTimeoutEntry `json:"timeouts"`
			} `json:"payload"`
		}
		if json.Unmarshal(m, &env) != nil {
			continue
		}
		switch {
		case env.Type == MsgTypeReady && env.Payload.Ready != nil:
			held, ok = entryIDs(*env.Payload.Ready), true
		case env.Type == MsgTypeMemberTimeouts && env.Payload.Timeouts != nil:
			held, ok = entryIDs(*env.Payload.Timeouts), true
		}
	}
	return held, ok
}

func hasFrameType(frames [][]byte, typ string) bool {
	for _, m := range frames {
		if strings.Contains(string(m), `"type":"`+typ+`"`) {
			return true
		}
	}
	return false
}

// A moderator demoted after its ready was built (with the full list) but
// before the connect recorded that: the role refresh finds the connection
// flagged full and sends its own-only list, which is what the client ends up
// holding.
func TestFreshConnect_RevokeDuringReady_EndsOwnOnly(t *testing.T) {
	d := newTimeoutDialFixture(t)
	setReadyTimeoutsCommitHook(t, func() { changeRole(t, d.timeoutViewFixture, d.modID, 4) })

	_, frames := d.dial(t, d.modID, 0)
	if !hasFrameType(frames, MsgTypeReady) {
		t.Fatalf("no ready among %d frames", len(frames))
	}
	held, ok := heldTimeoutList(t, frames)
	if !ok || len(held) != 0 {
		t.Fatalf("demoted moderator ends holding %v (ok=%v), want its own-only (empty) list", held, ok)
	}
	if liveClient(t, d.hub, d.modID).timeouts.full.Load() {
		t.Error("timeouts.full set on a connection that is no longer a moderator")
	}
}

// A member promoted after its ready was built (own-only) but before the
// connect recorded that: the role refresh sends the full list, and the
// connection stays flagged full so a later revoke reaches it.
func TestFreshConnect_GrantDuringReady_KeepsFullFlag(t *testing.T) {
	d := newTimeoutDialFixture(t)
	setReadyTimeoutsCommitHook(t, func() { changeRole(t, d.timeoutViewFixture, d.byID, 3) })

	conn, frames := d.dial(t, d.byID, 0)
	held, ok := heldTimeoutList(t, frames)
	if !ok || !reflect.DeepEqual(held, []int64{d.targetID}) {
		t.Fatalf("promoted member ends holding %v (ok=%v), want the full list", held, ok)
	}
	if !liveClient(t, d.hub, d.byID).timeouts.full.Load() {
		t.Fatal("timeouts.full not set on the promoted connection")
	}
	changeRole(t, d.timeoutViewFixture, d.byID, 4)
	if held, ok := heldTimeoutList(t, readUntilIdle(conn)); !ok || len(held) != 0 {
		t.Errorf("after the revoke the connection holds %v (ok=%v), want its own-only (empty) list", held, ok)
	}
}

// A replaying resume whose previous connection is already gone keeps the
// list that connection held, which may be the full one: a later revoke must
// still send the own-only list.
func TestReplayResume_NoOldClient_RevokeSendsOwnOnly(t *testing.T) {
	d := newTimeoutDialFixture(t)
	rb := d.hub.ReplayBuffer()
	for seq := uint64(96); seq <= 98; seq++ {
		rb.Push(seq, d.chID, []byte(`{"seq":`+itoaTest(int64(seq))+`,"type":"chat_message","payload":{"channel_id":`+itoaTest(d.chID)+`,"content":"x"}}`))
	}
	d.hub.SeedSeq(98)

	conn, frames := d.dial(t, d.modID, 97)
	if hasFrameType(frames, MsgTypeReady) {
		t.Fatalf("resume took a full ready; the test needs the replay path")
	}
	changeRole(t, d.timeoutViewFixture, d.modID, 4)
	held, ok := heldTimeoutList(t, readUntilIdle(conn))
	if !ok || len(held) != 0 {
		t.Fatalf("after the revoke the resumed connection holds %v (ok=%v), want its own-only (empty) list", held, ok)
	}
}

// fanoutInFlightAtResolve reports whether a reconnect registering right after
// a timeout delivery resolved its audience would be forced onto a full ready,
// even with a last_seq above every watermark bump so far.
func fanoutInFlightAtResolve(t *testing.T, h *Hub) *atomic.Bool {
	t.Helper()
	var forced atomic.Bool
	setTimeoutViewResolvedHook(t, func() {
		h.seqMu.Lock()
		forced.Store(h.mustFullResyncAtRegister(1<<62, 1<<40, ""))
		h.seqMu.Unlock()
	})
	return &forced
}

func TestPublishMemberTimeouts_ReconnectMidFanoutTakesFullReady(t *testing.T) {
	f := roleChangeFixture(t)
	forced := fanoutInFlightAtResolve(t, f.hub)

	f.hub.publishMemberTimeouts(f.targetID)

	if !forced.Load() {
		t.Error("a reconnect registering mid-publish was not forced onto a full ready")
	}
}

func TestRoleRefreshTimeoutViews_ReconnectMidFanoutTakesFullReady(t *testing.T) {
	f := roleChangeFixture(t)
	forced := fanoutInFlightAtResolve(t, f.hub)

	f.hub.refreshTimeoutViewsAfterRoleChange()

	if !forced.Load() {
		t.Error("a reconnect registering mid-refresh was not forced onto a full ready")
	}
}
