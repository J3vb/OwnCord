package ws

// wake_signal_test.go — U4 follow-up: a woken device must never silently
// displace a session that another device is actively holding.
//
// The client-side suspend gate could only guess from a wall-clock gap. Now the
// client marks a wake reconnect on the auth frame (`wake: true`) and the server
// arbitrates: when a *different session* (different device, hence a different
// token) is live, the wake is refused with ANOTHER_DEVICE_ACTIVE and the live
// session is left untouched. With no other device — or when the live client is
// this same session's own stale socket — the reconnect proceeds as before.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
)

// wakeFixture seeds one user with two independent sessions (two devices).
func wakeFixture(t *testing.T) (hub *Hub, uid int64, srvURL, tokenA, tokenB string) {
	t.Helper()
	database := newHarvestVoiceDB(t)
	uid = seedHarvestVoiceUser(t, database, "wake-device")
	var err error
	if tokenA, err = auth.GenerateToken(); err != nil {
		t.Fatalf("GenerateToken A: %v", err)
	}
	if tokenB, err = auth.GenerateToken(); err != nil {
		t.Fatalf("GenerateToken B: %v", err)
	}
	for label, token := range map[string]string{"device-a": tokenA, "device-b": tokenB} {
		if _, err := database.CreateSession(context.Background(), uid, auth.HashToken(token), label, "127.0.0.1"); err != nil {
			t.Fatalf("CreateSession %s: %v", label, err)
		}
	}
	hub = newTestHub(t, database, auth.NewRateLimiter(), nil)
	go hub.Run()
	t.Cleanup(hub.Stop)
	srv := httptest.NewServer(ServeWS(hub, []string{"*"}, 0))
	t.Cleanup(srv.Close)
	return hub, uid, srv.URL, tokenA, tokenB
}

// dialAndAuthWake dials and sends the given auth frame, marking a wake
// reconnect when wake is true.
func dialAndAuthWake(t *testing.T, ctx context.Context, srvURL, token string, lastSeq uint64, wake bool) *websocket.Conn {
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
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "") })
	payload := map[string]any{"token": token, "last_seq": lastSeq}
	if wake {
		payload["wake"] = true
	}
	raw, _ := json.Marshal(map[string]any{"type": "auth", "payload": payload})
	if err := conn.Write(dialCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}
	return conn
}

// readErrorCode reads frames until an `error` frame arrives and returns its
// payload code. The wake refusal is a plain error frame (the token is still
// valid), not auth_error, so a granted wake (auth_ok) surfaces as a failure.
func readErrorCode(t *testing.T, ctx context.Context, conn *websocket.Conn) string {
	t.Helper()
	for {
		typ, raw := readFrameType(t, ctx, conn)
		if typ != MsgTypeError {
			t.Fatalf("expected error, got %q (raw=%s)", typ, raw)
		}
		var frame struct {
			Payload struct {
				Code string `json:"code"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatalf("unmarshal error frame %s: %v", raw, err)
		}
		return frame.Payload.Code
	}
}

// A wake reconnect while another device holds the session is refused and the
// live session is not displaced.
func TestWakeReconnect_AnotherDeviceActive_RefusedWithoutDisplacing(t *testing.T) {
	hub, uid, srvURL, tokenA, tokenB := wakeFixture(t)
	ctx := context.Background()

	connA := dialAndAuthWake(t, ctx, srvURL, tokenA, 0, false)
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeAuthOK {
		t.Fatalf("device A: expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeReady {
		t.Fatalf("device A: expected ready, got %v", typ)
	}

	connB := dialAndAuthWake(t, ctx, srvURL, tokenB, 0, true)
	if code := readErrorCode(t, ctx, connB); code != ErrCodeAnotherDeviceActive {
		t.Fatalf("wake error code = %q, want %q", code, ErrCodeAnotherDeviceActive)
	}

	// The live session must be untouched: still A, still its own token, and
	// no SESSION_REPLACED frame was queued to A.
	live := hub.GetClient(uid)
	if live == nil {
		t.Fatal("device A was displaced by the refused wake")
	}
	if live.tokenHash != auth.HashToken(tokenA) {
		t.Fatalf("live session is not device A after the refused wake")
	}
	if live.isSendClosed() {
		t.Fatal("device A's connection was closed by the refused wake")
	}
}

// A wake reconnect with no other device connects normally — this is the
// single-device long-sleep case that used to need a manual reconnect.
func TestWakeReconnect_NoOtherDevice_Connects(t *testing.T) {
	_, _, srvURL, _, tokenB := wakeFixture(t)
	ctx := context.Background()

	conn := dialAndAuthWake(t, ctx, srvURL, tokenB, 0, true)
	if typ, _ := readFrameType(t, ctx, conn); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok for a lone-device wake, got %v", typ)
	}
}

// A wake reconnect for the same session's own stale socket is not a second
// device: it must connect and replace its own dead connection.
func TestWakeReconnect_SameSessionStaleSocket_Connects(t *testing.T) {
	hub, uid, srvURL, tokenA, _ := wakeFixture(t)
	ctx := context.Background()

	connA := dialAndAuthWake(t, ctx, srvURL, tokenA, 0, false)
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeAuthOK {
		t.Fatalf("device A: expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeReady {
		t.Fatalf("device A: expected ready, got %v", typ)
	}

	// Same token, mark wake: its own session, not another device.
	connA2 := dialAndAuthWake(t, ctx, srvURL, tokenA, 0, true)
	if typ, _ := readFrameType(t, ctx, connA2); typ != MsgTypeAuthOK {
		t.Fatalf("expected auth_ok for same-session wake reconnect, got %v", typ)
	}
	if live := hub.GetClient(uid); live == nil || live.tokenHash != auth.HashToken(tokenA) {
		t.Fatal("same-session wake did not take the connection back")
	}
}

// Without the wake marker the server keeps its last-connect-wins behaviour:
// a second device deliberately taking over still displaces the first.
func TestNormalConnect_AnotherDevice_StillDisplaces(t *testing.T) {
	_, _, srvURL, tokenA, tokenB := wakeFixture(t)
	ctx := context.Background()

	connA := dialAndAuthWake(t, ctx, srvURL, tokenA, 0, false)
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeAuthOK {
		t.Fatalf("device A: expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeReady {
		t.Fatalf("device A: expected ready, got %v", typ)
	}

	connB := dialAndAuthWake(t, ctx, srvURL, tokenB, 0, false)
	if typ, _ := readFrameType(t, ctx, connB); typ != MsgTypeAuthOK {
		t.Fatalf("device B: expected auth_ok, got %v", typ)
	}
	if !readUntilReplaced(t, ctx, connA) {
		t.Fatal("deliberate second-device connect did not displace the first")
	}
}
