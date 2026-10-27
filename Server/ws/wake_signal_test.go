package ws

// wake_signal_test.go — the auth frame's `wake: true` flag (a reconnect after
// the process was suspended). It used to make the server refuse a wake while
// another device held the account (U4, ANOTHER_DEVICE_ACTIVE). Several devices
// now stay signed in at once, so a wake is an ordinary connect: another
// device's connection is never displaced and nothing is refused.

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

// A wake reconnect while another device is connected is accepted and the
// other device's connection is not displaced: both stay registered.
func TestWakeReconnect_AnotherDeviceActive_CoexistsWithoutDisplacing(t *testing.T) {
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
	if typ, _ := readFrameType(t, ctx, connB); typ != MsgTypeAuthOK {
		t.Fatalf("device B: expected auth_ok for a wake beside another device, got %v", typ)
	}

	conns := hub.ClientsOfForTest(uid)
	if len(conns) != 2 {
		t.Fatalf("connections = %d, want both devices registered", len(conns))
	}
	if conns[0].tokenHash != auth.HashToken(tokenA) || conns[0].isSendClosed() {
		t.Fatal("device A was displaced or closed by device B's wake")
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
	if live := hub.ClientForTest(uid); live == nil || live.tokenHash != auth.HashToken(tokenA) {
		t.Fatal("same-session wake did not take the connection back")
	}
}

// Without the wake marker a second device connecting no longer displaces the
// first either: no SESSION_REPLACED reaches device A.
func TestNormalConnect_AnotherDevice_Coexists(t *testing.T) {
	hub, uid, srvURL, tokenA, tokenB := wakeFixture(t)
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
	if typ, _ := readFrameType(t, ctx, connB); typ != MsgTypeReady {
		t.Fatalf("device B: expected ready, got %v", typ)
	}
	if got := len(hub.ClientsOfForTest(uid)); got != 2 {
		t.Fatalf("connections = %d, want 2", got)
	}
	// A is still served: a broadcast reaches it, and it is not told it was replaced.
	hub.BroadcastToAll([]byte(`{"type":"server_notice","payload":{}}`))
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	for {
		_, raw, err := connA.Read(readCtx)
		if err != nil {
			t.Fatalf("device A read: %v", err)
		}
		if strings.Contains(string(raw), ErrCodeSessionReplaced) {
			t.Fatalf("device A was told it was replaced: %s", raw)
		}
		if strings.Contains(string(raw), "server_notice") {
			return
		}
	}
}

// A resuming wake (last_seq > 0) from another device is also an ordinary
// resume: it gets auth_ok and the live session is untouched.
func TestWakeReconnect_Resume_AnotherDeviceActive_Resumes(t *testing.T) {
	hub, uid, srvURL, tokenA, tokenB := wakeFixture(t)
	ctx := context.Background()

	connA := dialAndAuthWake(t, ctx, srvURL, tokenA, 0, false)
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeAuthOK {
		t.Fatalf("device A: expected auth_ok, got %v", typ)
	}
	if typ, _ := readFrameType(t, ctx, connA); typ != MsgTypeReady {
		t.Fatalf("device A: expected ready, got %v", typ)
	}
	// Give the ring a sequenced frame to resume from.
	hub.BroadcastToAll([]byte(`{"type":"server_notice","payload":{}}`))
	deadline := time.Now().Add(5 * time.Second)
	for hub.CurrentSeqForTest() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	seq := hub.CurrentSeqForTest()
	if seq == 0 {
		t.Fatal("no sequenced frame to resume from")
	}

	connB := dialAndAuthWake(t, ctx, srvURL, tokenB, seq, true)
	if typ, _ := readFrameType(t, ctx, connB); typ != MsgTypeAuthOK {
		t.Fatalf("device B: expected auth_ok for a resume beside another device, got %v", typ)
	}
	conns := hub.ClientsOfForTest(uid)
	if len(conns) != 2 || conns[0].tokenHash != auth.HashToken(tokenA) || conns[0].isSendClosed() {
		t.Fatal("a resuming wake from device B displaced device A")
	}
}
