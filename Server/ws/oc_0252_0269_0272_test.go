package ws

// oc_0252_0269_0272_test.go — regression tests for three 2026-08-21 bug hunt
// findings in serve.go's WS handshake path:
//
//   - OC-0252: freshConnectCleanStaleVoice deletes the voice_states row and
//     broadcasts voice_leave, but the still-registered OLD *Client's
//     in-memory voice state (voiceChID) and the E2EE key-holder election are
//     only ever cleared/re-run by registerNow — which two early-return paths
//     in handleFreshConnect can skip entirely, leaving a phantom key holder.
//   - OC-0269: upgradeAndAuth silently falls back to roleName "member" on a
//     role-lookup failure instead of failing closed like its sibling lookup
//     in handleFreshConnect, so a transient DB hiccup at handshake time can
//     pin a socket's authoritative wire role to "member" for its whole life.
//   - OC-0272: refreshUserSnapshot re-reads the user row for both handshake
//     paths but never re-checks banned/ban_expires, so a ban committing
//     during the handshake window does not stop the connection from being
//     fully registered.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
)

// TestFreshConnectCleanStaleVoice_ClearsOldClientVoiceState pins OC-0252.
//
// old is the still-registered *Client from the user's previous session,
// exactly as it would be in h.clients when handleFreshConnect runs
// freshConnectCleanStaleVoice on a genuinely fresh connect (lastSeq == 0).
// The DB row and the key holder election must not diverge from each other:
// once the row is gone, updateKeyHolder must run for whoever it named.
func TestFreshConnectCleanStaleVoice_ClearsOldClientVoiceState(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "oc0252-user")
	chID := mustCreateVoiceChannel(t, database, "oc0252-voice")

	if err := database.JoinVoiceChannel(ctx, uid, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	vs, err := database.GetVoiceState(ctx, uid)
	if err != nil || vs == nil {
		t.Fatalf("GetVoiceState: %v", err)
	}

	h := NewHub(database, auth.NewRateLimiter(), nil)

	// The still-registered OLD client from the previous session.
	old := NewTestClient(h, uid, make(chan []byte, 32))
	old.setVoiceState(chID, vs.JoinedAt)
	h.mu.Lock()
	h.clients[uid] = old
	h.mu.Unlock()
	h.updateKeyHolder(chID)
	if !h.IsVoiceKeyHolder(chID, uid) {
		t.Fatal("precondition: old client must be the elected key holder")
	}

	// The NEW connection attempting a fresh connect (lastSeq == 0), not yet
	// registered — exactly the state handleFreshConnect calls this in.
	c := NewTestClient(h, uid, make(chan []byte, 32))

	h.freshConnectCleanStaleVoice(ctx, database, c, vs)

	if got := old.getVoiceChID(); got != 0 {
		t.Errorf("old client's in-memory voiceChID = %d, want 0 (cleared alongside the DB row)", got)
	}
	if h.IsVoiceKeyHolder(chID, uid) {
		t.Error("voiceKeyHolders still names the departed user as key holder — a phantom key holder for the room")
	}
}

// TestUpgradeAndAuth_RoleLookupFailure_FailsClosed pins OC-0269: a role
// lookup that cannot resolve any role for the connecting user must close the
// connection rather than silently caching roleName "member" — the value
// auth_ok reports as the user's own role and member_join broadcasts to
// everyone else.
//
// Deleting the role row while users.role_id keeps pointing at it stands in
// for the finding's SQLITE_BUSY/I-O-hiccup scenario: GetRoleByID's ErrNoRows
// mapping returns (nil, nil) either way, which is exactly the branch
// upgradeAndAuth must treat as fatal.
func TestUpgradeAndAuth_RoleLookupFailure_FailsClosed(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "oc0269-user")

	// users.role_id carries a plain (non-cascading) FK to roles(id); an
	// in-memory DB is a single shared connection (db.Open), so toggling the
	// pragma here is safe and does not leak into any other test.
	if _, err := database.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		t.Fatalf("disable foreign_keys: %v", err)
	}
	if _, err := database.ExecContext(ctx, `DELETE FROM roles WHERE id = ?`, harvestVoiceRoleID); err != nil {
		t.Fatalf("delete role: %v", err)
	}
	if _, err := database.ExecContext(ctx, `PRAGMA foreign_keys=ON`); err != nil {
		t.Fatalf("re-enable foreign_keys: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(ctx, uid, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)

	type upgradeResult struct {
		c       *Client
		lastSeq uint64
		err     error
	}
	resultCh := make(chan upgradeResult, 1)

	// Exercises upgradeAndAuth in isolation, bypassing ServeWS/handleFreshConnect's
	// own (separate, already fail-closed) role lookup — going through the full
	// handshake would let that sibling catch this same failure downstream and
	// pass even with upgradeAndAuth's bug intact.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			t.Errorf("websocket.Accept: %v", acceptErr)
			return
		}
		c, lastSeq, err := hub.upgradeAndAuth(conn, database, r)
		resultCh <- upgradeResult{c, lastSeq, err}
	}))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 0, 0)
	// CloseNow, not Close: this test does not run its own close handshake
	// beyond the background reader below, and Close() would otherwise block
	// for its full handshake timeout on a peer that is no longer replying.
	defer func() { _ = conn.CloseNow() }()
	// The fixed upgradeAndAuth closes conn itself on the role-lookup failure
	// path (a graceful Close, which waits for the peer's close frame in
	// response). Nothing else on this side ever reads, so without an active
	// reader that wait would run out its own internal timeout before
	// resultCh ever received a value. A real client's readPump always has a
	// reader running for exactly this reason.
	go func() {
		for {
			if _, _, err := conn.Read(context.Background()); err != nil {
				return
			}
		}
	}()

	select {
	case res := <-resultCh:
		if res.err == nil {
			t.Fatalf("upgradeAndAuth must fail closed when the role lookup cannot resolve a role, "+
				"got roleName=%q instead of an error", res.c.roleName)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for upgradeAndAuth to return")
	}
}

// TestRefreshUserSnapshot_FailsClosedForBannedUser pins OC-0272:
// refreshUserSnapshot is the re-read both handshake paths (handleFreshConnect
// and reconnectPrecheck) call specifically to catch changes that landed
// between authenticateConn and registration — but it never checked banned
// status, so a ban committing during the handshake window went unnoticed and
// the connection sailed through to full registration.
func TestRefreshUserSnapshot_FailsClosedForBannedUser(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "oc0272-user")
	user, err := database.GetUserByID(ctx, uid)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	hub := NewHub(database, auth.NewRateLimiter(), nil)
	c := newClient(hub, nil, user, "", 0, ctx)

	// The ban commits AFTER authenticateConn passed (c.user is still the
	// pre-ban snapshot) but before this re-read — the exact window the
	// finding describes.
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET banned=1, ban_reason='test ban', ban_expires=NULL WHERE id=?`, uid); err != nil {
		t.Fatalf("ban user: %v", err)
	}

	if err := hub.refreshUserSnapshot(ctx, database, c); err == nil {
		t.Fatal("refreshUserSnapshot must fail closed for a now-banned user, got nil error")
	}
}
