package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// newPreauthTestServer starts a hub behind ServeWS with one member session and
// returns the server URL and the session token.
func newPreauthTestServer(t *testing.T, maxConns int) (*Hub, string, string) {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid := seedHarvestVoiceUser(t, database, "preauth-user")
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, maxConns))
	t.Cleanup(srv.Close)
	return hub, srv.URL, token
}

func dialNoAuth(t *testing.T, srvURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvURL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

// A 64 KiB first frame is refused by the read limit before it is parsed as an
// auth attempt, even when it carries a valid token; after auth the full
// message size applies again.
func TestServeWS_OversizedFirstFrameRejectedBeforeAuth(t *testing.T) {
	_, url, token := newPreauthTestServer(t, 0)
	ctx := context.Background()
	pad := strings.Repeat("x", 64<<10)

	conn := dialNoAuth(t, url)
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": token, "pad": pad}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, msg, err := conn.Read(readCtx)
	if err == nil {
		t.Fatalf("oversized first frame was answered: %s", msg)
	}
	if got := websocket.CloseStatus(err); got != websocket.StatusMessageTooBig {
		t.Fatalf("close status = %v (err %v), want StatusMessageTooBig", got, err)
	}

	authed := dialAndAuth(t, ctx, url, token, 0, 0)
	t.Cleanup(func() { _ = authed.CloseNow() })
	for {
		if typ, _ := readFrameType(t, ctx, authed); typ == MsgTypeReady {
			break
		}
	}
	ping, _ := json.Marshal(map[string]any{"type": MsgTypePing, "payload": map[string]any{"pad": pad}})
	if err := authed.Write(ctx, websocket.MessageText, ping); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	for {
		if typ, _ := readFrameType(t, ctx, authed); typ == MsgTypePong {
			return
		}
	}
}

// Sockets still in their auth window count toward max_ws_connections.
func TestServeWS_PendingHandshakesCountTowardCap(t *testing.T) {
	_, url, _ := newPreauthTestServer(t, 1)
	_ = dialNoAuth(t, url) // upgraded, never authenticates

	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status with one pending handshake at cap 1 = %d, want 503", resp.StatusCode)
	}
}
