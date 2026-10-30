package ws

// multi_device_test.go — one WebSocket connection per device session, not per
// account. A second device of the same user connects alongside the first; only
// a reconnect of the SAME session (Client.tokenHash) replaces a connection.
//
// The tests drive the real registry (registerNow / unregisterNow), the real
// voice handlers through handleMessage, and a fake SFU, against a live hub
// loop. Run with -race.

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// mdDev is one device: its connection plus every frame the hub has queued for
// it so far, in arrival order.
type mdDev struct {
	c   *Client
	got []map[string]any
	// closed is set once the hub closed the connection's send queue.
	closed bool
}

// pump moves whatever is queued on the connection into got.
func (d *mdDev) pump() {
	for {
		select {
		case raw, ok := <-d.c.send:
			if !ok {
				d.closed = true
				return
			}
			var env map[string]any
			if json.Unmarshal(raw, &env) == nil {
				d.got = append(d.got, env)
			}
		default:
			return
		}
	}
}

func frameType(f map[string]any) string {
	s, _ := f["type"].(string)
	return s
}

func framePayload(f map[string]any) map[string]any {
	p, _ := f["payload"].(map[string]any)
	return p
}

// index returns the position of the first frame at or after from that matches
// typ and pred (nil pred matches any), or -1.
func (d *mdDev) index(from int, typ string, pred func(map[string]any) bool) int {
	for i := from; i < len(d.got); i++ {
		if frameType(d.got[i]) == typ && (pred == nil || pred(framePayload(d.got[i]))) {
			return i
		}
	}
	return -1
}

// await polls until a frame matching typ and pred arrives and returns its index.
func (d *mdDev) await(t *testing.T, typ string, pred func(map[string]any) bool) int {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		d.pump()
		if i := d.index(0, typ, pred); i >= 0 {
			return i
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %q frame arrived; got %s", typ, d.types())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// settle gives the hub loop and background goroutines time to deliver anything
// they are going to, then pumps. It is how a test asserts that a frame did NOT
// arrive.
func (d *mdDev) settle() {
	time.Sleep(250 * time.Millisecond)
	d.pump()
}

func (d *mdDev) types() string {
	out := make([]string, 0, len(d.got))
	for _, f := range d.got {
		out = append(out, frameType(f))
	}
	return fmt.Sprint(out)
}

// sawVoiceLeave reports whether a voice_leave broadcast for (ch, uid) arrived.
func (d *mdDev) sawVoiceLeave(ch, uid int64) bool {
	return d.index(0, MsgTypeVoiceLeaveBC, func(p map[string]any) bool {
		return int64Of(p["channel_id"]) == ch && int64Of(p["user_id"]) == uid
	}) >= 0
}

func int64Of(v any) int64 {
	f, _ := v.(float64)
	return int64(f)
}

// sawErrorCode reports whether an error frame with code arrived.
func (d *mdDev) sawErrorCode(code string) bool {
	return d.index(0, "error", func(p map[string]any) bool { return p["code"] == code }) >= 0
}

type mdFix struct {
	t      *testing.T
	hub    *Hub
	db     *db.DB
	sfu    *fakeSFU
	uid    int64 // the multi-device account
	oid    int64 // an observer account
	user   *db.User
	text   int64
	voiceA int64
	voiceB int64
}

func newMDFix(t *testing.T) *mdFix {
	t.Helper()
	database := newHarvestVoiceDB(t)
	sfu := newFakeSFU()
	hub := newTestHubWith(t, HubOptions{DB: database, Limiter: auth.NewRateLimiter(), LiveKit: sfu.serve(t)})
	go hub.Run()
	t.Cleanup(hub.Stop)

	f := &mdFix{t: t, hub: hub, db: database, sfu: sfu}
	f.uid = seedHarvestVoiceUser(t, database, "md-user")
	f.oid = seedHarvestVoiceUser(t, database, "md-observer")
	user, err := database.GetUserByID(context.Background(), f.uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	f.user = user
	chID, err := database.CreateChannel(context.Background(), "md-text", "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	f.text = chID
	f.voiceA = mustCreateVoiceChannel(t, database, "md-voice-a")
	f.voiceB = mustCreateVoiceChannel(t, database, "md-voice-b")
	return f
}

// newConn builds (without registering) a connection for account uid on the
// given session. focus is the channel it is subscribed to.
func (f *mdFix) newConn(uid int64, session string, focus int64) *Client {
	user := f.user
	if uid != f.uid {
		u, err := f.db.GetUserByID(context.Background(), uid)
		if err != nil || u == nil {
			f.t.Fatalf("GetUserByID(%d): %v", uid, err)
		}
		user = u
	}
	return NewTestClientWithTokenHash(f.hub, user, auth.HashToken(session), focus, make(chan []byte, 1024))
}

// dev registers a device of the multi-device account.
func (f *mdFix) dev(session string, focus int64) *mdDev {
	f.t.Helper()
	c := f.newConn(f.uid, session, focus)
	f.hub.registerNowTest(c, map[int64]bool{focus: true})
	return &mdDev{c: c}
}

// observer registers a device of the observer account on a channel.
func (f *mdFix) observer(focus int64) *mdDev {
	f.t.Helper()
	c := f.newConn(f.oid, "observer", focus)
	f.hub.registerNowTest(c, map[int64]bool{focus: true})
	return &mdDev{c: c}
}

// join drives a real voice_join frame and models the participant's arrival at
// the SFU. It returns the join token.
func (f *mdFix) join(d *mdDev, chID int64) string {
	f.t.Helper()
	f.hub.handleMessage(d.c, voiceFrame(f.t, "voice_join", "join", map[string]any{"channel_id": chID}))
	ch, token := d.c.voice.state()
	if ch != chID || !d.c.voiceJoinCompletedForHarness() {
		f.t.Fatalf("voice_join to %d did not complete (in %d)", chID, ch)
	}
	f.sfu.add(RoomName(chID), participantIdentity(d.c.userID, token))
	return token
}

func (f *mdFix) row(uid int64) *db.VoiceState {
	f.t.Helper()
	vs, err := f.db.GetVoiceState(context.Background(), uid)
	if err != nil {
		f.t.Fatalf("GetVoiceState: %v", err)
	}
	return vs
}

// ─── coexistence and delivery ───────────────────────────────────────────────

func TestMultiDevice_TwoSessionsCoexistAndBothReceive(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)

	if n := len(f.hub.ClientsOfForTest(f.uid)); n != 2 {
		t.Fatalf("connections of the user = %d, want 2", n)
	}
	if a.c.isSendClosed() || b.c.isSendClosed() {
		t.Fatal("registering a second session closed a connection")
	}

	// A channel message reaches both devices.
	f.hub.BroadcastToChannel(f.text, []byte(`{"type":"md_channel","payload":{}}`))
	// A DM-style sequenced delivery addressed to the user reaches both.
	f.hub.DeliverBroadcastForTest(f.text, []int64{f.uid}, []byte(`{"type":"md_dm","payload":{}}`))
	// A frame sent to the user reaches both.
	if !f.hub.SendToUser(f.uid, []byte(`{"type":"md_user","payload":{}}`)) {
		t.Fatal("SendToUser reported no delivery")
	}
	for name, d := range map[string]*mdDev{"A": a, "B": b} {
		for _, typ := range []string{"md_channel", "md_dm", "md_user"} {
			if d.await(t, typ, nil) < 0 {
				t.Fatalf("device %s missed %s", name, typ)
			}
		}
		if d.sawErrorCode(ErrCodeSessionReplaced) {
			t.Fatalf("device %s was told SESSION_REPLACED", name)
		}
	}
	if !f.hub.IsUserConnected(f.uid) {
		t.Fatal("user not connected")
	}
}

func TestMultiDevice_SameSessionReconnectStillReplaces(t *testing.T) {
	f := newMDFix(t)
	old := f.dev("session-a", f.text)
	other := f.dev("session-b", f.text)

	again := f.newConn(f.uid, "session-a", f.text)
	again.lastSeq = 1
	f.hub.registerNowTest(again, map[int64]bool{f.text: true})

	old.pump()
	if !old.sawErrorCode(ErrCodeSessionReplaced) {
		t.Fatalf("replaced connection got no SESSION_REPLACED; got %s", old.types())
	}
	if !old.c.isSendClosed() {
		t.Fatal("replaced connection was not closed")
	}
	other.settle()
	if other.c.isSendClosed() || other.sawErrorCode(ErrCodeSessionReplaced) {
		t.Fatal("the other session was touched by a same-session reconnect")
	}
	conns := f.hub.ClientsOfForTest(f.uid)
	if len(conns) != 2 {
		t.Fatalf("connections = %d, want 2 (the replaced one is gone)", len(conns))
	}
	for _, c := range conns {
		if c == old.c {
			t.Fatal("replaced connection is still registered")
		}
	}
}

func TestMultiDevice_EleventhConnectionEvictsOldestOtherSession(t *testing.T) {
	f := newMDFix(t)
	devs := make([]*mdDev, 0, maxConnectionsPerUser+1)
	for i := range maxConnectionsPerUser {
		devs = append(devs, f.dev(fmt.Sprintf("session-%d", i), f.text))
	}
	if n := len(f.hub.ClientsOfForTest(f.uid)); n != maxConnectionsPerUser {
		t.Fatalf("connections = %d, want %d", n, maxConnectionsPerUser)
	}
	newest := f.dev("session-new", f.text)

	devs[0].pump()
	if !devs[0].sawErrorCode(ErrCodeSessionReplaced) || !devs[0].c.isSendClosed() {
		t.Fatalf("oldest connection was not evicted with SESSION_REPLACED; got %s", devs[0].types())
	}
	conns := f.hub.ClientsOfForTest(f.uid)
	if len(conns) != maxConnectionsPerUser {
		t.Fatalf("connections = %d, want %d after eviction", len(conns), maxConnectionsPerUser)
	}
	have := map[*Client]bool{}
	for _, c := range conns {
		have[c] = true
	}
	if have[devs[0].c] || !have[newest.c] {
		t.Fatal("registry should hold the newest connection and not the evicted one")
	}
	for i := 1; i < len(devs); i++ {
		devs[i].pump()
		if devs[i].c.isSendClosed() {
			t.Fatalf("connection %d was closed by the eviction", i)
		}
	}
}

// ─── kicks ──────────────────────────────────────────────────────────────────

func TestMultiDevice_BanClosesEveryDevice(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	obs := f.observer(f.text)

	f.hub.DisconnectUser(f.uid)

	for name, d := range map[string]*mdDev{"A": a, "B": b} {
		d.pump()
		if !d.closed && !d.c.isSendClosed() {
			t.Fatalf("device %s survived the ban", name)
		}
		if !d.sawErrorCode(ErrCodeBanned) {
			t.Fatalf("device %s was not told BANNED; got %s", name, d.types())
		}
	}
	if len(f.hub.ClientsOfForTest(f.uid)) != 0 {
		t.Fatal("a banned user still has registered connections")
	}
	if obs.c.isSendClosed() {
		t.Fatal("the ban closed another account's connection")
	}
}

func TestMultiDevice_SignOutEverywhereClosesEveryDevice(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)

	f.hub.DisconnectRevokedUser(f.uid)

	if !a.c.isSendClosed() || !b.c.isSendClosed() {
		t.Fatal("sign-out-everywhere left a device connected")
	}
	if len(f.hub.ClientsOfForTest(f.uid)) != 0 {
		t.Fatal("connections still registered")
	}
}

func TestMultiDevice_RevokedSessionClosesOnlyThatDevice(t *testing.T) {
	f := newMDFix(t)
	ctx := context.Background()
	for _, s := range []string{"session-a", "session-b"} {
		if _, err := f.db.CreateSession(ctx, f.uid, auth.HashToken(s), s, "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession: %v", err)
		}
	}
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)

	if err := f.db.DeleteSession(ctx, auth.HashToken("session-b")); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	f.hub.DisconnectIfSessionRevoked(f.uid)

	if !b.c.isSendClosed() {
		t.Fatal("the revoked session's device is still connected")
	}
	if a.c.isSendClosed() {
		t.Fatal("revoking one session closed the other device")
	}
	conns := f.hub.ClientsOfForTest(f.uid)
	if len(conns) != 1 || conns[0] != a.c {
		t.Fatalf("registry = %d connections, want only device A", len(conns))
	}
}

// ─── presence ───────────────────────────────────────────────────────────────

// teardown is the disconnect decision readPump's defer makes.
func (f *mdFix) teardown(d *mdDev) bool {
	replaced := f.hub.unregisterNow(d.c)
	return f.hub.shouldMarkOffline(d.c, replaced)
}

// A's teardown and B's register interleave: A is already unregistered when B
// registers, and A's offline decision runs afterwards. No offline while B is
// connected; exactly one when the last device drops.
func TestMultiDevice_PresenceRace_NoOfflineWhileAnotherDeviceConnects(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)

	replaced := f.hub.unregisterNow(a.c) // A's teardown starts: A is gone...
	b := f.dev("session-b", f.text)      // ...B registers before A decides.
	if f.hub.shouldMarkOffline(a.c, replaced) {
		t.Fatal("A's teardown marked the user offline while B is connected")
	}
	if !f.hub.IsUserConnected(f.uid) {
		t.Fatal("user should be online through B")
	}

	if !f.teardown(b) {
		t.Fatal("the last device dropping did not mark the user offline")
	}
	if f.hub.shouldMarkOffline(b.c, false) {
		t.Fatal("offline was decided a second time for the same last disconnect")
	}
	if f.hub.IsUserConnected(f.uid) {
		t.Fatal("user still connected after every device dropped")
	}
}

// Both devices tear down at once, many times over, under -race: exactly one of
// the two decisions per round is offline.
func TestMultiDevice_PresenceRace_ConcurrentTeardownMarksOfflineOnce(t *testing.T) {
	f := newMDFix(t)
	for round := range 200 {
		a := f.dev("session-a", f.text)
		b := f.dev("session-b", f.text)
		var wg sync.WaitGroup
		var mu sync.Mutex
		offline := 0
		for _, d := range []*mdDev{a, b} {
			wg.Go(func() {
				if f.teardown(d) {
					mu.Lock()
					offline++
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		if offline != 1 {
			t.Fatalf("round %d: offline decided %d times, want exactly 1", round, offline)
		}
	}
}

// ─── voice ──────────────────────────────────────────────────────────────────

// A is in a call; B (another session) connects fresh: the call is not touched.
// Then A reloads (same session, fresh): its own stale call is cleaned.
func TestMultiDevice_FreshConnectLeavesOtherDevicesCall(t *testing.T) {
	f := newMDFix(t)
	ctx := context.Background()
	obs := f.observer(f.voiceA)
	a := f.dev("session-a", f.text)
	token := f.join(a, f.voiceA)
	identity := participantIdentity(f.uid, token)
	obs.pump()
	obs.got = nil

	// B connects fresh, the way the handshake does it: clean stale voice, then register.
	b := f.newConn(f.uid, "session-b", f.text)
	vs := f.row(f.uid)
	if vs == nil {
		t.Fatal("precondition: A's voice row is missing")
	}
	f.hub.freshConnectCleanStaleVoiceTest(ctx, b, vs)
	f.hub.registerNowTest(b, map[int64]bool{f.text: true})

	obs.settle()
	if got := a.c.voice.channel(); got != f.voiceA {
		t.Fatalf("A's call was touched: voice channel = %d, want %d", got, f.voiceA)
	}
	if f.row(f.uid) == nil {
		t.Fatal("B's fresh connect deleted A's voice row")
	}
	if obs.sawVoiceLeave(f.voiceA, f.uid) {
		t.Fatal("B's fresh connect broadcast a voice_leave for A's call")
	}
	if !f.sfu.has(RoomName(f.voiceA), identity) {
		t.Fatal("B's fresh connect removed A's LiveKit participant")
	}
	if vc := f.hub.VoiceClientForTest(f.uid); vc != a.c {
		t.Fatal("A is no longer the voice connection")
	}

	// A reloads: same session, fresh connect. Its own stale call goes.
	a2 := f.newConn(f.uid, "session-a", f.text)
	f.hub.freshConnectCleanStaleVoiceTest(ctx, a2, f.row(f.uid))
	f.hub.registerNowTest(a2, map[int64]bool{f.text: true})

	waitFor(t, "A's stale voice row to be cleaned", func() bool { return f.row(f.uid) == nil })
	obs.await(t, MsgTypeVoiceLeaveBC, func(p map[string]any) bool {
		return int64Of(p["channel_id"]) == f.voiceA && int64Of(p["user_id"]) == f.uid
	})
	waitFor(t, "A's LiveKit participant to be removed", func() bool { return !f.sfu.has(RoomName(f.voiceA), identity) })
}

// A is in a call on channel from; B (another session) joins channel to.
func moveCall(t *testing.T, from, to func(f *mdFix) int64) {
	t.Helper()
	f := newMDFix(t)
	obs := f.observer(from(f))
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	fromCh, toCh := from(f), to(f)
	tokenA := f.join(a, fromCh)
	obs.pump()
	obs.got = nil
	a.pump()
	a.got = nil
	identityA := participantIdentity(f.uid, tokenA)

	tokenB := f.join(b, toCh)
	identityB := participantIdentity(f.uid, tokenB)

	// A is told why its call ended, and told BEFORE any frame produced by B's join.
	di := a.await(t, MsgTypeVoiceDisconnected, nil)
	if reason := framePayload(a.got[di])["reason"]; reason != voiceMovedReason {
		t.Fatalf("voice_disconnected reason = %v, want %q", reason, voiceMovedReason)
	}
	if reason := framePayload(a.got[di])["reason"]; reason != "Call moved to another device" {
		t.Fatalf("reason text drifted: %v", reason)
	}
	a.settle()
	for i, fr := range a.got {
		switch frameType(fr) {
		case MsgTypeVoiceState, MsgTypeVoiceLeaveBC, MsgTypeVoiceConfig, MsgTypeVoiceToken:
			if i < di {
				t.Fatalf("frame %d (%s) reached A before voice_disconnected; order: %s", i, frameType(fr), a.types())
			}
		}
	}

	if a.c.voice.channel() != 0 {
		t.Fatal("A is still in a call after the move")
	}
	if got := b.c.voice.channel(); got != toCh {
		t.Fatalf("B's voice channel = %d, want %d", got, toCh)
	}
	if vc := f.hub.VoiceClientForTest(f.uid); vc != b.c {
		t.Fatal("B should be the voice connection")
	}

	// One room entry per account: a single row, in the target channel.
	rows, err := f.db.GetAllVoiceStates(context.Background())
	if err != nil {
		t.Fatalf("GetAllVoiceStates: %v", err)
	}
	n := 0
	for _, r := range rows {
		if r.UserID == f.uid {
			n++
			if r.ChannelID != toCh {
				t.Fatalf("voice row in channel %d, want %d", r.ChannelID, toCh)
			}
		}
	}
	if n != 1 {
		t.Fatalf("roster shows the user %d times, want once", n)
	}
	waitFor(t, "A's LiveKit participant to be removed", func() bool { return !f.sfu.has(RoomName(fromCh), identityA) })
	if !f.sfu.has(RoomName(toCh), identityB) {
		t.Fatal("B's LiveKit participant is missing")
	}

	obs.settle()
	left := obs.sawVoiceLeave(fromCh, f.uid)
	if fromCh == toCh && left {
		t.Fatal("a same-channel move broadcast a voice_leave, which would tear down B's own new join")
	}
	if fromCh != toCh && !left {
		t.Fatalf("a different-channel move broadcast no voice_leave for the old channel; got %s", obs.types())
	}

	// A's late voice_leave (its client had not yet processed the disconnect)
	// must not touch B's call.
	f.hub.handleMessage(a.c, voiceFrame(t, "voice_leave", "late", map[string]any{}))
	a.settle()
	obs.got = nil
	obs.settle()
	if got := b.c.voice.channel(); got != toCh {
		t.Fatalf("A's late voice_leave ended B's call: voice channel = %d", got)
	}
	if r := f.row(f.uid); r == nil || r.ChannelID != toCh {
		t.Fatalf("A's late voice_leave changed the voice row: %+v", r)
	}
	if !f.sfu.has(RoomName(toCh), identityB) {
		t.Fatal("A's late voice_leave removed B's LiveKit participant")
	}
	if obs.sawVoiceLeave(toCh, f.uid) {
		t.Fatal("A's late voice_leave was broadcast")
	}
}

func TestMultiDevice_VoiceJoinMovesCall_DifferentChannel(t *testing.T) {
	t.Parallel()
	moveCall(t, func(f *mdFix) int64 { return f.voiceA }, func(f *mdFix) int64 { return f.voiceB })
}

func TestMultiDevice_VoiceJoinMovesCall_SameChannel(t *testing.T) {
	t.Parallel()
	moveCall(t, func(f *mdFix) int64 { return f.voiceA }, func(f *mdFix) int64 { return f.voiceA })
}

// A device that holds no call cannot end, mute or otherwise change the call
// another device holds: current clients send voice_leave on ready when ready
// shows their own user in voice but they hold no call locally.
func TestMultiDevice_VoiceCommandsFromNonHoldingDeviceAreNoOps(t *testing.T) {
	t.Parallel()
	f := newMDFix(t)
	obs := f.observer(f.voiceA)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	token := f.join(a, f.voiceA)
	identity := participantIdentity(f.uid, token)
	before := f.row(f.uid)
	obs.pump()
	obs.got = nil
	a.pump()
	a.got = nil

	cmds := []struct {
		typ     string
		payload map[string]any
	}{
		{MsgTypeVoiceLeave, map[string]any{}},
		{MsgTypeVoiceMute, map[string]any{"muted": true}},
		{MsgTypeVoiceDeafen, map[string]any{"deafened": true}},
		{MsgTypeVoiceCamera, map[string]any{"enabled": true}},
		{MsgTypeVoiceScreenshare, map[string]any{"enabled": true}},
	}
	for i, cmd := range cmds {
		f.hub.handleMessage(b.c, voiceFrame(t, cmd.typ, fmt.Sprintf("b-%d", i), cmd.payload))
	}
	obs.settle()
	a.settle()

	if got := a.c.voice.channel(); got != f.voiceA {
		t.Fatalf("A's call was changed by B's commands: voice channel = %d", got)
	}
	after := f.row(f.uid)
	if after == nil || after.ChannelID != f.voiceA {
		t.Fatalf("A's voice row was changed: %+v", after)
	}
	if before != nil && (after.Muted != before.Muted || after.Deafened != before.Deafened || after.Camera != before.Camera || after.Screenshare != before.Screenshare) {
		t.Fatalf("A's voice flags were changed by B: before %+v after %+v", before, after)
	}
	if !f.sfu.has(RoomName(f.voiceA), identity) {
		t.Fatal("B's commands removed A's LiveKit participant")
	}
	for _, typ := range []string{MsgTypeVoiceState, MsgTypeVoiceLeaveBC} {
		if i := obs.index(0, typ, func(p map[string]any) bool { return int64Of(p["user_id"]) == f.uid }); i >= 0 {
			t.Fatalf("B's no-op commands produced a %s broadcast", typ)
		}
	}
	if a.index(0, MsgTypeVoiceDisconnected, nil) >= 0 {
		t.Fatal("A was told its call ended")
	}
}

// ─── review fixes ───────────────────────────────────────────────────────────

// dropSocket is a device's socket closing: unregister, then the voice step of
// the teardown (which parks a completed call in the grace window).
func (f *mdFix) dropSocket(d *mdDev) {
	f.t.Helper()
	f.hub.unregisterNow(d.c)
	f.hub.leaveVoiceOnDisconnect(context.Background(), d.c, voiceLeaveReasonDisconnect)
}

func (f *mdFix) expectCallGone(identity string, ch int64) {
	f.t.Helper()
	if f.hub.voiceReg.voiceGrace.get(f.uid) != nil {
		f.t.Fatal("the parked grace entry survived")
	}
	waitFor(f.t, "voice row to be removed", func() bool { return f.row(f.uid) == nil })
	waitFor(f.t, "LiveKit participant to be removed", func() bool { return !f.sfu.has(RoomName(ch), identity) })
}

func TestMultiDevice_BanEndsCallParkedByAnotherDevice(t *testing.T) {
	for name, kick := range map[string]func(*Hub, int64){
		"ban":                 func(h *Hub, uid int64) { h.DisconnectUser(uid) },
		"sign-out-everywhere": func(h *Hub, uid int64) { h.DisconnectRevokedUser(uid) },
	} {
		t.Run(name, func(t *testing.T) {
			f := newMDFix(t)
			a := f.dev("session-a", f.text)
			token := f.join(a, f.voiceA)
			f.dropSocket(a)
			if f.hub.voiceReg.voiceGrace.get(f.uid) == nil {
				t.Fatal("precondition: A's call should be parked")
			}
			b := f.dev("session-b", f.text)

			kick(f.hub, f.uid)

			if !b.c.isSendClosed() {
				t.Fatal("B survived")
			}
			f.expectCallGone(participantIdentity(f.uid, token), f.voiceA)
		})
	}
}

func TestMultiDevice_AFKJudgesTheCallHoldingDevice(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	f.join(a, f.voiceA)
	long := time.Now().Add(-time.Hour)
	set := func(d *mdDev, status string, at time.Time) {
		p := &livePresence{status: status, setAt: at}
		if status == db.StatusIdle {
			p.idleSince = long
		}
		d.c.presence.Store(p)
	}
	cutoff := time.Now().Add(-time.Minute)

	// The call device is active; a background device idled later: not AFK.
	set(a, db.StatusOnline, long)
	set(b, db.StatusIdle, time.Now())
	if got := f.hub.afkCandidates(0, cutoff); len(got) != 0 {
		t.Fatalf("an idle background device made the active call AFK: %d candidates", len(got))
	}
	// The call device is idle although the other device is active: AFK.
	set(a, db.StatusIdle, long)
	set(b, db.StatusOnline, time.Now())
	if got := f.hub.afkCandidates(0, cutoff); len(got) != 1 || got[0].c != a.c {
		t.Fatalf("an idle call device was not an AFK candidate: %d candidates", len(got))
	}
}

func TestMultiDevice_ShownStatusNonIdleDeviceWins(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	choose := func(d *mdDev, status string) {
		f.hub.applyPresenceChoice(d.c, &livePresence{status: status}, nil)
	}
	want := func(step, status string) {
		t.Helper()
		if got := f.hub.LiveStatus(f.uid); got != status {
			t.Fatalf("%s: shown %q, want %q", step, got, status)
		}
	}
	choose(a, db.StatusDND)
	want("A dnd", db.StatusDND)
	choose(b, db.StatusOnline) // the newest choice wins over A's older dnd
	want("A dnd, then B online", db.StatusOnline)
	choose(a, db.StatusOnline)
	choose(b, db.StatusIdle) // B's auto-idle stamps only B
	want("A online, B auto-idle", db.StatusOnline)
	if st := a.c.livePresence().status; st != db.StatusOnline {
		t.Fatalf("B's auto-idle changed A to %q", st)
	}
	choose(a, db.StatusIdle)
	want("both idle", db.StatusIdle)
	choose(a, db.StatusInvisible)
	want("A invisible after idle", db.StatusInvisible)
	if st := b.c.livePresence().status; st != db.StatusInvisible {
		t.Fatalf("a chosen status was not stamped on B: %q", st)
	}
}

func TestMultiDevice_SameSessionRejoinOfParkedCallIsNotAMove(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	f.dropSocket(a)
	// The same session joins the same channel while its call is parked.
	again := &mdDev{c: f.newConn(f.uid, "session-a", f.text)}
	f.join(again, f.voiceA)

	resumed := f.newConn(f.uid, "session-a", f.text)
	resumed.lastSeq = 1
	f.hub.registerNowTest(resumed, map[int64]bool{f.text: true})
	d := &mdDev{c: resumed}
	d.pump()
	if d.index(0, MsgTypeVoiceDisconnected, nil) >= 0 {
		t.Fatalf("a session re-joining its own parked call was told it moved; got %s", d.types())
	}
}

func TestMultiDevice_MovedNoteDroppedOnFreshConnect(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	f.dropSocket(a)
	b := f.dev("session-b", f.text)
	f.join(b, f.voiceB)

	fresh := f.newConn(f.uid, "session-a", f.text) // lastSeq 0: a reload
	f.hub.registerNowTest(fresh, map[int64]bool{f.text: true})
	d := &mdDev{c: fresh}
	d.pump()
	if d.index(0, MsgTypeVoiceDisconnected, nil) >= 0 {
		t.Fatal("a fresh connect was sent the moved notice")
	}
	if f.hub.voiceReg.voiceGrace.takeMoved(f.uid, auth.HashToken("session-a")) != 0 {
		t.Fatal("the note should have been consumed by the fresh connect")
	}
}

func TestMultiDevice_FlushDropsQueuedOfflineForConnectedUser(t *testing.T) {
	f := newMDFix(t)
	f.dev("session-a", f.text)
	obs := f.observer(f.text)
	const gone = int64(99999)
	f.hub.presenceMu.Lock()
	f.hub.presenceQueue = map[int64]pendingPresence{
		f.uid: {status: db.StatusOffline}, // connected: stale, dropped
		gone:  {status: db.StatusOffline}, // not connected: broadcast
	}
	f.hub.presenceMu.Unlock()
	f.hub.flushPresenceQueue()

	i := obs.await(t, "presence_batch", nil)
	updates, _ := framePayload(obs.got[i])["updates"].([]any)
	seen := map[int64]bool{}
	for _, u := range updates {
		m, _ := u.(map[string]any)
		seen[int64Of(m["user_id"])] = true
	}
	if seen[f.uid] {
		t.Fatalf("the offline entry for a connected user was broadcast: %v", updates)
	}
	if !seen[gone] {
		t.Fatalf("the offline entry for an unconnected user was dropped: %v", updates)
	}
}

func TestMultiDevice_ModeratorFramesReachOnlyTheCallDevice(t *testing.T) {
	t.Parallel()
	t.Run("live call", func(t *testing.T) {
		f := newMDFix(t)
		b := f.dev("session-b", f.text)
		f.join(b, f.voiceA) // B leaves a call recently: A's join moves it
		a := f.dev("session-a", f.text)
		f.join(a, f.voiceB)
		a.pump()
		b.pump()
		a.got, b.got = nil, nil

		if !f.hub.EvictForModeratorMove(context.Background(), f.uid, f.voiceB, false, false, nil) {
			t.Fatal("moderator move did not evict")
		}
		if !f.hub.SendToVoiceDevice(f.uid, buildVoiceMoved(f.voiceA, "", 99)) {
			t.Fatal("no device received the moderator frame")
		}
		a.await(t, MsgTypeVoiceMoved, nil)
		b.settle()
		if b.index(0, MsgTypeVoiceMoved, nil) >= 0 {
			t.Fatal("the idle device received voice_moved and would steal the call")
		}
	})
	t.Run("parked call", func(t *testing.T) {
		f := newMDFix(t)
		a := f.dev("session-a", f.text)
		b := f.dev("session-b", f.text)
		f.join(a, f.voiceA)
		f.dropSocket(a)
		b.pump()
		b.got = nil

		if !f.hub.EvictForModeratorMove(context.Background(), f.uid, f.voiceA, false, false, nil) {
			t.Fatal("moderator move did not tear down the parked call")
		}
		if f.hub.SendToVoiceDevice(f.uid, buildVoiceMoved(f.voiceB, "", 99)) {
			t.Fatal("a parked call's moderator frame was routed to another device")
		}
		b.settle()
		if b.index(0, MsgTypeVoiceMoved, nil) >= 0 {
			t.Fatal("device B received voice_moved for A's parked call")
		}
	})
}

func TestMultiDevice_ParkedCallMovedTellsTheOldSession(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	f.join(a, f.voiceA)
	f.dropSocket(a)
	b := f.dev("session-b", f.text)
	f.join(b, f.voiceB)
	if f.hub.voiceReg.voiceGrace.get(f.uid) != nil {
		t.Fatal("B's join should have taken the parked call")
	}

	a2c := f.newConn(f.uid, "session-a", f.text)
	a2c.lastSeq = 1
	f.hub.registerNowTest(a2c, map[int64]bool{f.text: true})
	a2 := &mdDev{c: a2c}
	a2.pump()
	i := a2.index(0, MsgTypeVoiceDisconnected, nil)
	if i < 0 || framePayload(a2.got[i])["reason"] != voiceMovedReason {
		t.Fatalf("returning session was not told its call moved; got %s", a2.types())
	}
	// Told once.
	again := f.newConn(f.uid, "session-a", f.text)
	again.lastSeq = 2
	f.hub.registerNowTest(again, map[int64]bool{f.text: true})
	d := &mdDev{c: again}
	d.pump()
	if d.index(0, MsgTypeVoiceDisconnected, nil) >= 0 {
		t.Fatal("the moved notice was delivered twice")
	}
}

func TestMultiDevice_CapEvictionSparesTheCallHolder(t *testing.T) {
	f := newMDFix(t)
	devs := make([]*mdDev, 0, maxConnectionsPerUser)
	for i := range maxConnectionsPerUser {
		devs = append(devs, f.dev(fmt.Sprintf("session-%d", i), f.text))
	}
	f.join(devs[0], f.voiceA) // the oldest device holds the call
	f.dev("session-new", f.text)

	if devs[0].c.isSendClosed() || devs[0].c.voice.channel() != f.voiceA {
		t.Fatal("the cap evicted the device holding the call")
	}
	if !devs[1].c.isSendClosed() {
		t.Fatal("the oldest device without a call was not evicted")
	}
	if n := len(f.hub.ClientsOfForTest(f.uid)); n != maxConnectionsPerUser {
		t.Fatalf("connections = %d, want %d", n, maxConnectionsPerUser)
	}
}

// A connection removed by a kick (not displaced by registerNow) tears down its
// own call even when its session has since reconnected; a displaced one leaves
// the call to its replacement.
func TestMultiDevice_KickedConnectionKeepsOwnTeardownEvenAfterSessionReconnects(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	token := f.join(a, f.voiceA)
	f.hub.kickClient(a.c)
	f.dev("session-a", f.text) // the session reconnects (fresh)
	if replaced := f.hub.unregisterNow(a.c); replaced {
		t.Fatal("a kicked connection was treated as displaced, leaving its call to the 60 s sweep")
	}
	f.hub.leaveVoiceOnDisconnect(context.Background(), a.c, voiceLeaveReasonDisconnect)
	if f.hub.voiceReg.voiceGrace.get(f.uid) == nil {
		t.Fatal("the kicked connection's call was neither parked nor torn down")
	}
	_ = token

	// Displacement still defers to the replacement.
	g := newMDFix(t)
	old := g.dev("session-a", g.text)
	g.dev("session-a", g.text)
	if replaced := g.hub.unregisterNow(old.c); !replaced {
		t.Fatal("a displaced connection must report replaced")
	}
}

// A game and a song belong to the connection that set them: another device
// connecting does not blank them, the user's shown activity merges across
// devices, and they end when that device's connection goes while the other
// stays.
func TestMultiDevice_GameAndSongBelongToTheConnectionThatSetThem(t *testing.T) {
	f := newMDFix(t)
	f.hub.gameActivity.on.Store(true)
	a := f.dev("session-a", f.text)
	a.c.setLivePresence(db.StatusOnline, nil, "")
	game := &gameActivity{Name: "Chess", StartedAt: 1}
	song := &listeningActivity{Title: "T", Artist: "A", Player: "P", StartedAt: 2}
	f.hub.applyActivity(a.c, game)
	f.hub.applyListening(a.c, song)

	b := f.dev("session-b", f.text)
	b.c.setLivePresence(db.StatusOnline, nil, "") // B connects later and is the newest setter
	merged := mergeLivePresence(f.hub.clientsOf(f.uid))
	if merged.activity == nil || merged.listening == nil {
		t.Fatalf("B connecting blanked A's game/song: %+v", merged)
	}
	if got := f.hub.userListening(b.c); got == nil || got.Title != "T" {
		t.Fatalf("B's frames do not carry the user's song: %+v", got)
	}

	f.hub.unregisterNow(a.c)
	merged = mergeLivePresence(f.hub.clientsOf(f.uid))
	if merged.activity != nil || merged.listening != nil {
		t.Fatalf("A's game/song outlived A's connection: %+v", merged)
	}
	if !f.hub.IsUserConnected(f.uid) {
		t.Fatal("B should still be connected")
	}
}

// presenceOf returns the statuses the observer has been sent for uid, from
// both presence frames and presence_batch updates, in order.
func presenceOf(d *mdDev, uid int64) []string {
	d.pump()
	var out []string
	for _, fr := range d.got {
		p := framePayload(fr)
		switch frameType(fr) {
		case "presence":
			if int64Of(p["user_id"]) == uid {
				out = append(out, fmt.Sprint(p["status"]))
			}
		case "presence_batch":
			ups, _ := p["updates"].([]any)
			for _, u := range ups {
				m, _ := u.(map[string]any)
				if int64Of(m["user_id"]) == uid {
					out = append(out, fmt.Sprint(m["status"]))
				}
			}
		}
	}
	return out
}

// An auto-idle from one device must not show the user idle to others while
// another device is active: the frame follows the merged status.
func TestMultiDevice_AutoIdleFromOneDeviceDoesNotShowUserIdle(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	obs := f.observer(f.text)
	apply := func(d *mdDev, status string) {
		env := envelope{Type: MsgTypePresenceUpdate}
		res := Result{Events: presenceEvents(f.uid, status, nil, nil, nil), SetPresence: &livePresence{status: status}}
		f.hub.handleMessageApply(context.Background(), context.Background(), d.c, env, "", res, time.Now())
	}

	apply(a, db.StatusOnline)
	waitFor(t, "A's online to be delivered", func() bool { return len(presenceOf(obs, f.uid)) >= 1 })
	obs.got = nil
	apply(b, db.StatusIdle) // B auto-idles while A stays online
	obs.settle()
	if got := presenceOf(obs, f.uid); len(got) != 0 {
		t.Fatalf("B's auto-idle was broadcast although the user is still online on A: %v", got)
	}
	if st := f.hub.LiveStatus(f.uid); st != db.StatusOnline {
		t.Fatalf("shown status = %q, want online", st)
	}

	apply(a, db.StatusIdle) // now every device is idle: idle is shown
	waitFor(t, "idle to be delivered", func() bool {
		g := presenceOf(obs, f.uid)
		return len(g) > 0 && g[len(g)-1] == db.StatusIdle
	})
}

// A moderator move leaves the mute on the device it evicted; the user joining
// from another device keeps it.
func TestMultiDevice_ModeratorFlagsFollowADeviceChange(t *testing.T) {
	f := newMDFix(t)
	a := f.dev("session-a", f.text)
	b := f.dev("session-b", f.text)
	f.join(a, f.voiceA)

	if !f.hub.EvictForModeratorMove(context.Background(), f.uid, f.voiceA, true, false, nil) {
		t.Fatal("moderator move did not evict")
	}
	if a.c.voice.channel() != 0 {
		t.Fatal("A should be out of the call")
	}
	f.join(b, f.voiceB) // the user changes device before rejoining

	row := f.row(f.uid)
	if row == nil || !row.ServerMuted {
		t.Fatalf("the moderator mute was lost on the device change: %+v", row)
	}
	if sm, _ := a.c.peekPendingModFlagsForHarness(); sm {
		t.Fatal("A still holds a stash that would be applied a second time")
	}
}

func TestMultiDevice_FullChannelJoinKeepsCallParkedByAnotherDevice(t *testing.T) {
	f := newMDFix(t)
	if err := f.db.SetChannelVoiceMaxUsers(context.Background(), f.voiceB, 1); err != nil {
		t.Fatalf("SetChannelVoiceMaxUsers: %v", err)
	}
	f.join(f.observer(f.text), f.voiceB)
	a := f.dev("session-a", f.text)
	token := f.join(a, f.voiceA)
	f.dropSocket(a)
	if f.hub.voiceReg.voiceGrace.get(f.uid) == nil {
		t.Fatal("precondition: A's call should be parked")
	}
	b := f.dev("session-b", f.text)

	f.hub.handleMessage(b.c, voiceFrame(t, "voice_join", "join", map[string]any{"channel_id": f.voiceB}))
	b.settle()

	if !b.sawErrorCode(ErrCodeChannelFull) {
		t.Fatalf("B's join to a full channel was not refused as full; got %s", b.types())
	}
	if f.hub.voiceReg.voiceGrace.get(f.uid) == nil {
		t.Fatal("the refused join ended A's parked call")
	}
	if r := f.row(f.uid); r == nil || r.ChannelID != f.voiceA {
		t.Fatalf("A's voice row changed: %+v", r)
	}
	if !f.sfu.has(RoomName(f.voiceA), participantIdentity(f.uid, token)) {
		t.Fatal("the refused join removed A's LiveKit participant")
	}
}
