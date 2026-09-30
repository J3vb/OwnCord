package ws_test

// SRE-11: with trusted_proxies configured, the WebSocket handshake log and the
// ws_connect audit row must record the client's address (from X-Forwarded-For),
// not the reverse proxy's r.RemoteAddr. Before the fix both used RemoteAddr, so
// the recommended reverse-proxy deployment could not trace a client.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/ws"
)

// TestServeWS_TrustedProxy_LogsAndAuditsClientIP drives a real handshake
// through Serving with trusted_proxies set and asserts both the log line and
// the audit row name the client IP, never the proxy hop.
func TestServeWS_TrustedProxy_LogsAndAuditsClientIP(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubWith(t, ws.HubOptions{
		DB:             database,
		Limiter:        limiter,
		TrustedProxies: []string{"10.0.0.0/8"},
	})
	go hub.Run()
	defer hub.Stop()

	user := seedServeUser(t, database, "sre11-user")
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), user.ID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	logs := captureSRE11Log(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := dialThroughTrustedProxy(ctx, t, hub, token)

	// Read the auth_ok so the handshake has fully completed.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		readCtx, readCancel := context.WithTimeout(ctx, time.Second)
		_, msg, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
		if strings.Contains(string(msg), "auth_ok") {
			break
		}
	}

	// The handshake log must name the client, not the proxy.
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(logs.String(), "websocket connected") {
		time.Sleep(20 * time.Millisecond)
	}
	out := logs.String()
	if !strings.Contains(out, "203.0.113.7") {
		t.Errorf("handshake log did not record the client IP: %q", out)
	}
	if strings.Contains(out, "10.0.0.9") {
		t.Errorf("handshake log recorded the proxy's address instead of the client's: %q", out)
	}

	// The audit row must name the client too.
	var detail string
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		row := database.QueryRowContext(context.Background(),
			`SELECT detail FROM audit_log WHERE action = 'ws_connect' AND actor_id = ? ORDER BY id DESC LIMIT 1`, user.ID)
		if scanErr := row.Scan(&detail); scanErr == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(detail, "203.0.113.7") {
		t.Errorf("ws_connect audit row recorded %q, want the client IP 203.0.113.7", detail)
	}
	if strings.Contains(detail, "10.0.0.9") {
		t.Errorf("ws_connect audit row recorded the proxy's address: %q", detail)
	}
}

// TestServeWS_TrustedProxy_FailedAuthLogsClientIP covers the failure branch:
// a rejected token behind a trusted proxy must log the client, not the proxy.
func TestServeWS_TrustedProxy_FailedAuthLogsClientIP(t *testing.T) {
	database := openServeTestDB(t)
	hub := newTestHubWith(t, ws.HubOptions{
		DB:             database,
		Limiter:        auth.NewRateLimiter(),
		TrustedProxies: []string{"10.0.0.0/8"},
	})
	go hub.Run()
	defer hub.Stop()

	logs := captureSRE11Log(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn := dialThroughTrustedProxy(ctx, t, hub, "not-a-valid-token")

	// The server closes the socket after the failure log; drain until then.
	for {
		readCtx, readCancel := context.WithTimeout(ctx, time.Second)
		_, _, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			break
		}
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(logs.String(), "ws auth failed") {
		time.Sleep(20 * time.Millisecond)
	}
	out := logs.String()
	if !strings.Contains(out, "ws auth failed") {
		t.Fatalf("no ws auth failed log line: %q", out)
	}
	if !strings.Contains(out, "remote=203.0.113.7") {
		t.Errorf("failed-auth log did not record the client IP: %q", out)
	}
	if strings.Contains(out, "10.0.0.9") {
		t.Errorf("failed-auth log recorded the proxy's address instead of the client's: %q", out)
	}
}

// dialThroughTrustedProxy connects to hub as if through a trusted proxy hop —
// RemoteAddr is the proxy (10.0.0.9), the real client rides in
// X-Forwarded-For — and sends an auth frame carrying token.
func dialThroughTrustedProxy(ctx context.Context, t *testing.T, hub *ws.Hub, token string) *websocket.Conn {
	t.Helper()
	handler := ws.ServeWS(hub, []string{"*"}, 0)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = "10.0.0.9:54321"
		r.Header.Set("X-Forwarded-For", "203.0.113.7")
		handler(w, r)
	}))
	t.Cleanup(srv.Close)

	conn, dialResp, dialErr := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if dialResp != nil && dialResp.Body != nil {
		_ = dialResp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("websocket.Dial: %v", dialErr)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": map[string]any{"token": token}})
	if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	return conn
}

// sre11LogBuffer is a slog sink safe to read while handler goroutines write.
type sre11LogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *sre11LogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *sre11LogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func captureSRE11Log(t *testing.T) *sre11LogBuffer {
	t.Helper()
	logs := &sre11LogBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return logs
}
