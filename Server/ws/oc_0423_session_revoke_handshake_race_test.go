package ws

// oc_0423_session_revoke_handshake_race_test.go — regression tests for
// OC-0423: DisconnectRevokedUser (sign-out-everywhere / account recovery)
// only inspects h.clients at the instant it runs, and a connection is not
// added to h.clients until registerNow — the very last step of a handshake
// that can spend real DB time first (computeAllowedChannels,
// computeReadableChannels, cold-tier replay queries, buildReady's own
// queries). A session revoked while that handshake is still in flight is
// invisible to DisconnectRevokedUser, and nothing downstream re-checks the
// session row: the socket comes up fully authorized on a deleted session
// until sweepRevokedSessions' next tick (up to ~60s) or the client's 10th
// inbound frame (SessionCheckInterval), whichever comes first.
//
// freshConnectPreRegisterRaceHook fires inside handleFreshConnect
// immediately before registerNow — exactly the window in which
// DisconnectRevokedUser finds h.clients empty for this user and no-ops,
// reproducing the finding's repro step 3 deterministically instead of
// racing real goroutines against real DB latency.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// TestFreshConnect_SessionRevokedDuringHandshake_DisconnectsSocket pins
// OC-0423 on the fresh-connect path (serve_ready.go's handleFreshConnect).
//
// The hook mirrors exactly what RevokeAllSessions / RedeemRecoveryKit do:
// delete the session row, then call DisconnectRevokedUser(uid) — but from
// inside the window where registerNow has not yet run, so that call finds
// nothing to kick. Before the fix, nothing downstream ever re-checks the
// session and the handshake completes normally (auth_ok + ready), leaving a
// fully authorized socket on a session row that no longer exists.
func TestFreshConnect_SessionRevokedDuringHandshake_DisconnectsSocket(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "session-revoke-race-user")

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(ctx, uid, tokenHash, "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	var hookRan bool
	freshConnectPreRegisterRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		// Sign-out-everywhere / recovery-kit redemption: delete the session
		// row, then notify the hub — the same order
		// api/profile_handler.go's RevokeAllSessions and
		// service/recovery.go's RedeemRecoveryKit use. registerNow has not
		// run yet, so DisconnectRevokedUser finds h.clients empty for uid
		// and returns having kicked nothing — the finding's repro step 3.
		if _, err := database.ExecContext(context.Background(),
			`DELETE FROM sessions WHERE token = ?`, tokenHash); err != nil {
			t.Fatalf("revoke session: %v", err)
		}
		hub.DisconnectRevokedUser(uid)
	}
	defer func() { freshConnectPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 0, 0)
	defer func() { _ = conn.CloseNow() }()

	// A real client always keeps a reader running; without one, a graceful
	// Close on the server side (as the fix performs) would block on the
	// close handshake it never gets a reply to.
	frameTypes := make(chan string, 4)
	go func() {
		for {
			readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, msg, readErr := conn.Read(readCtx)
			cancel()
			if readErr != nil {
				close(frameTypes)
				return
			}
			var parsed struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(msg, &parsed)
			frameTypes <- parsed.Type
		}
	}()

	// Drain whatever frames arrive (there must be no ready payload: a
	// revoked session must never be served one) and wait for the read loop
	// to end, one way or another.
	sawReady := false
	deadline := time.After(5 * time.Second)
drain:
	for {
		select {
		case typ, ok := <-frameTypes:
			if !ok {
				break drain
			}
			if typ == MsgTypeReady {
				sawReady = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for the handshake to conclude")
		}
	}

	if !hookRan {
		t.Fatal("freshConnectPreRegisterRaceHook never fired — not exercising the race window")
	}
	if sawReady {
		t.Fatal("server sent a ready payload for a session that was revoked during the handshake")
	}

	// The decisive check: whatever frames went out, the connection must not
	// end up as a live, registered, fully authorized client — the whole
	// point of DisconnectRevokedUser is that a revoked session's socket
	// does not outlive the revocation.
	deadline2 := time.Now().Add(2 * time.Second)
	for {
		hub.mu.RLock()
		c, stillRegistered := hub.clients[uid]
		hub.mu.RUnlock()
		if !stillRegistered {
			return // fixed: never stayed registered past the revocation
		}
		if c.isSendClosed() {
			return // fixed: registered then immediately kicked
		}
		if time.Now().After(deadline2) {
			t.Fatal("a socket authenticated on a revoked session is live and fully registered in h.clients " +
				"after the handshake completed — DisconnectRevokedUser's whole purpose (drop the connection " +
				"rather than wait for the sweep) was defeated by the in-flight handshake")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestReconnect_SessionRevokedDuringHandshake_DisconnectsSocket pins OC-0423
// on the OTHER production registerNow caller: replay.go's reconnectRegister
// (the resume/replay handshake). registerNow has two call sites and the
// finding's fix must close the race for both, not just the one the finding's
// repro happened to walk through — a guard added to only one caller would
// leave this one broken.
//
// handleReconnectPostCheckPreRegisterRaceHook fires inside reconnectRegister
// immediately before registerNow (after the mustFullResync re-check passes),
// mirroring freshConnectPreRegisterRaceHook's role for the fresh-connect
// path above.
func TestReconnect_SessionRevokedDuringHandshake_DisconnectsSocket(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "session-revoke-reconnect-user")
	chID := mustCreateTextChannel(t, database, "session-revoke-reconnect-channel")

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(ctx, uid, tokenHash, "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Bracket last_seq so the resume takes the buffer tier and reaches
	// reconnectRegister, where the hook fires — same setup as
	// TestFreshConnectFallback_RoleReassignMidReconnect_ResolvesFreshRole.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	var hookRan bool
	handleReconnectPostCheckPreRegisterRaceHook = func() {
		if hookRan {
			return
		}
		hookRan = true
		// Same revoke-then-notify sequence as the fresh-connect test above,
		// timed to land right before registerNow runs.
		if _, err := database.ExecContext(context.Background(),
			`DELETE FROM sessions WHERE token = ?`, tokenHash); err != nil {
			t.Fatalf("revoke session: %v", err)
		}
		hub.DisconnectRevokedUser(uid)
	}
	defer func() { handleReconnectPostCheckPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	frameTypes := make(chan string, 8)
	go func() {
		for {
			readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, msg, readErr := conn.Read(readCtx)
			cancel()
			if readErr != nil {
				close(frameTypes)
				return
			}
			var parsed struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(msg, &parsed)
			frameTypes <- parsed.Type
		}
	}()

	// Unlike a fresh connect, a successful resume never sends a "ready"
	// payload — auth_ok (replay_source != "none") IS the fully-authorized
	// confirmation for this path, so that is the frame that must not go out
	// for a session revoked during the handshake.
	sawAuthOK := false
	deadline := time.After(5 * time.Second)
drain:
	for {
		select {
		case typ, ok := <-frameTypes:
			if !ok {
				break drain
			}
			if typ == MsgTypeAuthOK {
				sawAuthOK = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for the handshake to conclude")
		}
	}

	if !hookRan {
		t.Fatal("handleReconnectPostCheckPreRegisterRaceHook never fired — not exercising the race window")
	}
	if sawAuthOK {
		t.Fatal("server sent auth_ok (reconnect), confirming a resumed live session, for a session that was " +
			"revoked during the reconnect handshake")
	}

	deadline2 := time.Now().Add(2 * time.Second)
	for {
		hub.mu.RLock()
		c, stillRegistered := hub.clients[uid]
		hub.mu.RUnlock()
		if !stillRegistered {
			return
		}
		if c.isSendClosed() {
			return
		}
		if time.Now().After(deadline2) {
			t.Fatal("a resumed socket authenticated on a revoked session is live and fully registered in " +
				"h.clients after the reconnect handshake completed")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
