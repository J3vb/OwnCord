package ws

// ban_during_handshake_test.go pins that a ban committing while a handshake
// is in flight, after refreshUserSnapshot's ban check but before registerNow,
// still ends the connection. The ban path's DisconnectUser call runs in that
// window, finds no registered client and kicks nothing, so the
// post-registerNow recheck is what has to catch it. Same race hooks as
// oc_0423_session_revoke_handshake_race_test.go, on both registerNow callers.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// banHandshakeFrames reads conn until it closes and returns the frame types
// seen, plus whether a BANNED error frame arrived.
func banHandshakeFrames(t *testing.T, conn *websocket.Conn) (map[string]bool, bool) {
	t.Helper()
	type frame struct {
		Type    string `json:"type"`
		Payload struct {
			Code string `json:"code"`
		} `json:"payload"`
	}
	frames := make(chan frame, 8)
	go func() {
		defer close(frames)
		for {
			readCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, msg, err := conn.Read(readCtx)
			cancel()
			if err != nil {
				return
			}
			var f frame
			_ = json.Unmarshal(msg, &f)
			frames <- f
		}
	}()
	seen := map[string]bool{}
	sawBanned := false
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-frames:
			if !ok {
				return seen, sawBanned
			}
			seen[f.Type] = true
			if f.Type == MsgTypeError && f.Payload.Code == ErrCodeBanned {
				sawBanned = true
			}
		case <-deadline:
			t.Fatal("timed out waiting for the handshake to conclude")
			return seen, sawBanned
		}
	}
}

// assertNotLiveClient fails unless uid's socket is gone from h.clients or
// already closed.
func assertNotLiveClient(t *testing.T, hub *Hub, uid int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		hub.mu.RLock()
		c := hub.newestLocked(uid)
		hub.mu.RUnlock()
		if c == nil || c.isSendClosed() {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("a socket of a user banned during the handshake is live and registered in h.clients")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func newBanHandshakeSession(t *testing.T, database *db.DB, uid int64) string {
	t.Helper()
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	return token
}

func TestFreshConnect_BannedDuringHandshake_DisconnectsSocket(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "ban-handshake-fresh-user")
	token := newBanHandshakeSession(t, database, uid)

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	var hookRan atomic.Bool
	freshConnectPreRegisterRaceHook = func() {
		if !hookRan.CompareAndSwap(false, true) {
			return
		}
		// The ban handler's order: commit the ban, then DisconnectUser.
		// registerNow has not run yet, so DisconnectUser kicks nothing.
		if err := database.BanUser(context.Background(), uid, "test", nil); err != nil {
			t.Errorf("BanUser: %v", err)
		}
		hub.DisconnectUser(uid)
	}
	defer func() { freshConnectPreRegisterRaceHook = nil }()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 0, 0)
	defer func() { _ = conn.CloseNow() }()

	seen, sawBanned := banHandshakeFrames(t, conn)
	if !hookRan.Load() {
		t.Fatal("freshConnectPreRegisterRaceHook never fired")
	}
	if seen[MsgTypeReady] {
		t.Fatal("server sent a ready payload to a user banned during the handshake")
	}
	if !sawBanned {
		t.Fatalf("no BANNED error frame before the close; frames seen: %v", seen)
	}
	assertNotLiveClient(t, hub, uid)
}

func TestReconnect_BannedDuringHandshake_DisconnectsSocket(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "ban-handshake-reconnect-user")
	chID := mustCreateTextChannel(t, database, "ban-handshake-reconnect-channel")
	token := newBanHandshakeSession(t, database, uid)

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()

	// Bracket last_seq so the resume takes the buffer tier and reaches
	// reconnectRegister, where the hook fires.
	rb := hub.ReplayBuffer()
	rb.Push(98, chID, []byte(`{"seq":98,"type":"chat_message","payload":{}}`))
	rb.Push(99, chID, []byte(`{"seq":99,"type":"chat_message","payload":{}}`))
	rb.Push(100, chID, []byte(`{"seq":100,"type":"chat_message","payload":{}}`))
	hub.SeedSeq(100)

	var hookRan atomic.Bool
	banDone := make(chan struct{})
	handleReconnectPostCheckPreRegisterRaceHook = func() {
		if !hookRan.CompareAndSwap(false, true) {
			return
		}
		if err := database.BanUser(context.Background(), uid, "test", nil); err != nil {
			t.Errorf("BanUser: %v", err)
		}
		// The hook runs inside the reconnect's voice-lock section, which
		// DisconnectUser also takes, so it runs alongside.
		go func() {
			defer close(banDone)
			hub.DisconnectUser(uid)
		}()
	}
	defer func() {
		handleReconnectPostCheckPreRegisterRaceHook = nil
		if hookRan.Load() {
			<-banDone
		}
	}()

	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 99, chID)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	seen, sawBanned := banHandshakeFrames(t, conn)
	if !hookRan.Load() {
		t.Fatal("handleReconnectPostCheckPreRegisterRaceHook never fired")
	}
	if seen[MsgTypeAuthOK] {
		t.Fatal("server sent auth_ok (reconnect) to a user banned during the handshake")
	}
	if !sawBanned {
		t.Fatalf("no BANNED error frame before the close; frames seen: %v", seen)
	}
	assertNotLiveClient(t, hub, uid)
}
