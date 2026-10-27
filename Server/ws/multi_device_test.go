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
	moveCall(t, func(f *mdFix) int64 { return f.voiceA }, func(f *mdFix) int64 { return f.voiceB })
}

func TestMultiDevice_VoiceJoinMovesCall_SameChannel(t *testing.T) {
	moveCall(t, func(f *mdFix) int64 { return f.voiceA }, func(f *mdFix) int64 { return f.voiceA })
}

// A device that holds no call cannot end, mute or otherwise change the call
// another device holds: current clients send voice_leave on ready when ready
// shows their own user in voice but they hold no call locally.
func TestMultiDevice_VoiceCommandsFromNonHoldingDeviceAreNoOps(t *testing.T) {
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
