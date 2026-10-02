package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// TestSocketSession_TouchSlidesExpiry pins DP-05 on the WebSocket path, which
// a long-lived socket may use without ever making a REST call: the handshake
// slides a 29-day-old session's expiry, and a ping slides it again once the
// touch interval has passed but not before.
func TestSocketSession_TouchSlidesExpiry(t *testing.T) {
	database := newHarvestVoiceDB(t)
	ctx := context.Background()
	uid := seedHarvestVoiceUser(t, database, "session-touch-user")

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(ctx, uid, tokenHash, "test-device", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	sentinel := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02T15:04:05Z")
	backdate := func() {
		t.Helper()
		if _, err := database.ExecContext(ctx,
			`UPDATE sessions SET created_at = datetime('now', '-29 days'), expires_at = ? WHERE token = ?`,
			sentinel, tokenHash); err != nil {
			t.Fatalf("backdate session: %v", err)
		}
	}
	expiresAt := func() string {
		t.Helper()
		sess, err := database.GetSessionByTokenHash(ctx, tokenHash)
		if err != nil || sess == nil {
			t.Fatalf("GetSessionByTokenHash: %v (sess=%v)", err, sess)
		}
		return sess.ExpiresAt
	}
	backdate()

	hub := newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	defer hub.Stop()
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	defer srv.Close()

	conn := dialAndAuth(t, ctx, srv.URL, token, 0, 0)
	defer func() { _ = conn.CloseNow() }()
	readUntil := func(want string) {
		t.Helper()
		for {
			if typ, _ := readFrameType(t, ctx, conn); typ == want {
				return
			}
		}
	}
	readUntil(MsgTypeReady)

	got, err := time.Parse("2006-01-02T15:04:05Z", expiresAt())
	if err != nil {
		t.Fatalf("parse expires_at: %v", err)
	}
	if d := time.Until(got) - 30*24*time.Hour; d < -time.Minute || d > time.Minute {
		t.Fatalf("after socket auth expires_at = %v, want about now + 30 days", got)
	}

	ping := func() {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"type": MsgTypePing, "payload": map[string]any{}})
		if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatalf("write ping: %v", err)
		}
		readUntil(MsgTypePong)
	}

	// A ping right after the handshake's touch is inside the interval.
	backdate()
	ping()
	if expiresAt() != sentinel {
		t.Fatal("ping inside the touch interval wrote expires_at; want it throttled")
	}

	// Once the interval has passed, a ping slides the expiry again.
	c := waitForRegisteredClient(t, hub, uid)
	c.mu.Lock()
	c.lastTouch = time.Now().Add(-sessionTouchInterval - time.Second)
	c.mu.Unlock()
	ping()
	if expiresAt() <= sentinel {
		t.Fatal("ping after the touch interval did not slide expires_at")
	}
}
