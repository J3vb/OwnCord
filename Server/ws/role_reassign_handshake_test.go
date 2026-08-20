package ws

// role_reassign_handshake_test.go — regression tests for audit-2026-08-19
// F-2: a role reassignment racing a WS handshake must not leave the socket
// on subscriptions resolved from the auth-time role snapshot.
//
// The defect had three cooperating halves:
//  1. reconnectPrecheck / handleFreshConnect resolved permissions from
//     c.user, the row fetched at auth time, so a reassignment landing after
//     auth was invisible to the whole handshake.
//  2. revokeUnreadableChannels early-returns for a user not yet in
//     h.clients, so the reassignment's own revocation pass cannot reach a
//     mid-handshake socket.
//  3. revokeUnreadableChannels acted on its entry-time *Client snapshot;
//     when a reconnect replaced the client mid-loop, unsubscribeLocked's
//     identity guard turned the revocation into a no-op on the replacement.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// demotedRoleID carries no permissions at all, so a member reassigned to it
// loses READ_MESSAGES on every channel.
const demotedRoleID = int64(201)

func seedDemotedRole(t *testing.T, database *db.DB) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`INSERT INTO roles (id, name, color, permissions, position, is_default)
		 VALUES (?, 'harvest-demoted', NULL, 0, 4, 0)`, demotedRoleID); err != nil {
		t.Fatalf("seed demoted role: %v", err)
	}
}

func reassignRole(t *testing.T, database *db.DB, uid, roleID int64) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(),
		`UPDATE users SET role_id = ? WHERE id = ?`, roleID, uid); err != nil {
		t.Fatalf("reassign role: %v", err)
	}
}

func mustCreateTextChannel(t *testing.T, database *db.DB, name string) int64 {
	t.Helper()
	chID, err := database.CreateChannel(context.Background(), name, "text", "", "", 0)
	if err != nil {
		t.Fatalf("CreateChannel %s: %v", name, err)
	}
	return chID
}

// dialAndAuth opens a WS connection against srv and sends the auth frame.
func dialAndAuth(t *testing.T, ctx context.Context, srvURL, token string, lastSeq uint64, activeChannelID int64) *websocket.Conn {
	t.Helper()
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	conn, dialResp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srvURL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	payload := map[string]any{"token": token, "last_seq": lastSeq}
	if activeChannelID != 0 {
		payload["active_channel_id"] = activeChannelID
	}
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	return conn
}

// readFrameType reads one frame and returns its type field.
func readFrameType(t *testing.T, ctx context.Context, conn *websocket.Conn) (string, []byte) {
	t.Helper()
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, msg, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var parsed struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(msg, &parsed); err != nil {
		t.Fatalf("unmarshal frame %q: %v", msg, err)
	}
	return parsed.Type, msg
}

func waitForRegisteredClient(t *testing.T, hub *Hub, uid int64) *Client {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.mu.Lock()
		c := hub.clients[uid]
		hub.mu.Unlock()
		if c != nil {
			return c
		}
		if time.Now().After(deadline) {
			t.Fatal("client was never registered")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func assertNotSubscribed(t *testing.T, hub *Hub, uid, chID int64, when string) {
	t.Helper()
	hub.mu.Lock()
	c := hub.clients[uid]
	hub.mu.Unlock()
	if c != nil && c.getChannelID() == chID {
		t.Errorf("%s: client kept focus on channel %d resolved from the stale role", when, chID)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.pubsub.mu.RLock()
		sub := hub.pubsub.topics[ChannelTopic(chID)][uid]
		hub.pubsub.mu.RUnlock()
		if sub == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Errorf("%s: client is still subscribed to ChannelTopic(%d) after the role reassignment — "+
				"every broadcast to that channel keeps reaching a socket whose role cannot read it", when, chID)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// refreshUserSnapshot is the primitive both handshake paths now call: it must
// replace the auth-time user row (and role name) with the current one.
func TestRefreshUserSnapshot_PicksUpRoleReassignment(t *testing.T) {
	database := newHarvestVoiceDB(t)
	seedDemotedRole(t, database)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "refresh-snapshot-user")
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	c := newClient(hub, nil, user, "", 0, ctx)
	c.roleName = "harvest-voice"

	reassignRole(t, database, uid, demotedRoleID)

	if err := hub.refreshUserSnapshot(ctx, database, c); err != nil {
		t.Fatalf("refreshUserSnapshot: %v", err)
	}
	if c.user.RoleID != demotedRoleID {
		t.Errorf("c.user.RoleID = %d, want %d (stale auth-time snapshot kept)", c.user.RoleID, demotedRoleID)
	}
	if c.roleName != "harvest-demoted" {
		t.Errorf("c.roleName = %q, want %q", c.roleName, "harvest-demoted")
	}
}

// A role reassignment landing mid-reconnect (inside the seqMu window the
// existing hook exposes) bumps the visibility watermark and forces the
// full-ready fallback — which must then resolve everything from the NEW role.
// Before the fix, handleFreshConnect reused the auth-time c.user, recomputed
// the same stale answer, and re-subscribed the revoked channel.
func TestFreshConnectFallback_RoleReassignMidReconnect_ResolvesFreshRole(t *testing.T) {
	database := newHarvestVoiceDB(t)
	seedDemotedRole(t, database)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "role-race-user")
	chID := mustCreateTextChannel(t, database, "role-race-channel")

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Bracket last_seq so the resume takes the buffer tier and reaches the
	// final mustFullResync re-check, where the hook fires.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	var hookRan bool
	handleReconnectPreRegisterRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		reassignRole(t, database, uid, demotedRoleID)
		// The real admin path: member_update fan-out + revocation pass. The
		// revocation cannot reach this not-yet-registered socket — that is
		// the hazard — but its watermark bump forces the full-ready fallback.
		hub.BroadcastMemberUpdate(uid, "harvest-demoted")
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, database, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// The forced fallback writes auth_ok then ready.
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	typ, readyMsg := readFrameType(t, ctx, conn)
	if typ != MsgTypeReady {
		t.Fatalf("expected ready (forced fallback), got %v", typ)
	}
	if !hookRan {
		t.Fatal("handleReconnectPreRegisterRaceHook never fired — not exercising the race window")
	}

	// The ready payload must be the demoted role's view: no revoked channel.
	var ready struct {
		Payload struct {
			Channels []struct {
				ID int64 `json:"id"`
			} `json:"channels"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(readyMsg, &ready); err != nil {
		t.Fatalf("unmarshal ready: %v", err)
	}
	for _, ch := range ready.Payload.Channels {
		if ch.ID == chID {
			t.Errorf("ready payload contains channel %d, which the reassigned role cannot read", chID)
		}
	}

	waitForRegisteredClient(t, hub, uid)
	assertNotSubscribed(t, hub, uid, chID, "post-fallback")
}

// A reassignment landing in the residual window — after handleFreshConnect's
// own user re-read but before registerNow — finds the socket absent from
// h.clients (so the admin path's revocation pass early-returns) yet the
// inherited subscription is built from the pre-change read. The post-register
// re-read must close exactly this: either ordering ends with the revoked
// channel unsubscribed.
func TestFreshConnectFallback_RoleReassignPreRegister_PostRegisterVerifyRevokes(t *testing.T) {
	database := newHarvestVoiceDB(t)
	seedDemotedRole(t, database)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "role-race-late-user")
	chID := mustCreateTextChannel(t, database, "role-race-late-channel")

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	// First hook: force the full-ready fallback WITHOUT touching the role,
	// so the auth-hint promotion into c.channelID survives into
	// handleFreshConnect.
	handleReconnectPreRegisterRaceHook = func() {
		hub.MarkVisibilityChanged()
	}
	defer func() { handleReconnectPreRegisterRaceHook = nil }()

	// Second hook: the reassignment lands after handleFreshConnect's re-read
	// and before registerNow — the exact window the post-register verify
	// exists for.
	var lateHookRan bool
	freshConnectPreRegisterRaceHook = func() {
		if lateHookRan {
			return
		}
		lateHookRan = true
		reassignRole(t, database, uid, demotedRoleID)
		hub.BroadcastMemberUpdate(uid, "harvest-demoted")
	}
	defer func() { freshConnectPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, database, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeReady {
		t.Fatalf("expected ready (forced fallback), got %v", typ)
	}
	if !lateHookRan {
		t.Fatal("freshConnectPreRegisterRaceHook never fired — not exercising the race window")
	}

	waitForRegisteredClient(t, hub, uid)
	assertNotSubscribed(t, hub, uid, chID, "post-register-verify")
}

// revokeUnreadableChannels must act on the CURRENT holder of the user's
// slot: its per-topic DB round trips give a reconnect room to replace the
// *Client it looked up at entry, and unsubscribeLocked's identity guard
// makes an Unsubscribe on the stale pointer a silent no-op — stranding the
// replacement with the revoked topic.
func TestRevokeUnreadableChannels_ActsOnReplacementClient(t *testing.T) {
	database := newHarvestVoiceDB(t)
	seedDemotedRole(t, database)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "revoke-replaced-user")
	chID := mustCreateTextChannel(t, database, "revoke-replaced-channel")

	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	c1 := newClient(hub, nil, user, "", 0, ctx)
	c2 := newClient(hub, nil, user, "", 0, ctx)

	hub.mu.Lock()
	hub.clients[uid] = c1
	hub.mu.Unlock()
	hub.pubsub.Subscribe(c1, ChannelTopic(chID))

	// The user is demoted; the revocation pass will find chID unreadable.
	reassignRole(t, database, uid, demotedRoleID)

	// Mid-loop, a reconnect replaces the client — the replacement holds the
	// topic (its own handshake subscribed it before the demotion was
	// visible to it).
	revokeUnreadableChannelsPreActRaceHook = func(int64) {
		hub.mu.Lock()
		hub.clients[uid] = c2
		hub.mu.Unlock()
		hub.pubsub.Subscribe(c2, ChannelTopic(chID))
	}
	defer func() { revokeUnreadableChannelsPreActRaceHook = nil }()

	hub.revokeUnreadableChannels(uid)

	hub.pubsub.mu.RLock()
	sub := hub.pubsub.topics[ChannelTopic(chID)][uid]
	hub.pubsub.mu.RUnlock()
	if sub != nil {
		t.Errorf("replacement client is still subscribed to ChannelTopic(%d): "+
			"the revocation acted on the stale snapshot and no-opped on the identity guard", chID)
	}
}
