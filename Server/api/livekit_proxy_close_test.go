package api_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/api"
)

// closingWSBackend accepts one WebSocket, waits for one message, then closes
// with code and reason.
func closingWSBackend(t *testing.T, code websocket.StatusCode, reason string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		if _, _, err := conn.Read(r.Context()); err != nil {
			return
		}
		_ = conn.Close(code, reason) //nolint:errcheck // the test reads the code at the client
	}))
	t.Cleanup(srv.Close)
	return "ws://" + srv.Listener.Addr().String()
}

func dialProxy(t *testing.T, ctx context.Context, backend string) *websocket.Conn {
	t.Helper()
	proxy := httptest.NewServer(api.NewLiveKitProxy(backend, []string{"*"}))
	t.Cleanup(proxy.Close)
	conn, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial through proxy: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

// The SFU's close code and reason reach the client unchanged, up to the longest
// reason a close frame holds.
func TestLiveKitProxy_WebSocket_ForwardsBackendCloseCode(t *testing.T) {
	longest := strings.Repeat("r", 123)
	for _, tc := range []struct {
		name, reason, want string
	}{
		{"short", "participant removed", "participant removed"},
		{"longest", longest, longest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			conn := dialProxy(t, ctx, closingWSBackend(t, 4001, tc.reason))
			if err := conn.Write(ctx, websocket.MessageText, []byte("hi")); err != nil {
				t.Fatalf("write: %v", err)
			}
			_, _, err := conn.Read(ctx)
			ce, ok := errors.AsType[websocket.CloseError](err)
			if !ok {
				t.Fatalf("read err = %v, want a close frame", err)
			}
			if ce.Code != 4001 || ce.Reason != tc.want {
				t.Fatalf("close = %d %q, want 4001 %q", ce.Code, ce.Reason, tc.want)
			}
		})
	}
}

// The client's close code reaches the SFU.
func TestLiveKitProxy_WebSocket_ForwardsClientCloseCode(t *testing.T) {
	got := make(chan websocket.CloseError, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // best-effort
		_, _, err = conn.Read(r.Context())
		if ce, ok := errors.AsType[websocket.CloseError](err); ok {
			got <- ce
		}
	}))
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	conn := dialProxy(t, ctx, "ws://"+srv.Listener.Addr().String())
	if err := conn.Close(websocket.StatusGoingAway, "leaving"); err != nil {
		t.Logf("client close: %v", err)
	}
	select {
	case ce := <-got:
		if ce.Code != websocket.StatusGoingAway || ce.Reason != "leaving" {
			t.Fatalf("backend saw %d %q, want 1001 \"leaving\"", ce.Code, ce.Reason)
		}
	case <-ctx.Done():
		t.Fatal("backend never saw a close frame")
	}
}

// A backend that accepts TCP but never answers the handshake gets a 502 once
// the dial bound passes, not a handler held open.
func TestLiveKitProxy_WebSocket_DialTimeout(t *testing.T) {
	t.Cleanup(api.SetLiveKitProxyDialTimeoutForTest(200 * time.Millisecond))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			t.Cleanup(func() { _ = c.Close() })
		}
	}()

	proxy := httptest.NewServer(api.NewLiveKitProxy("ws://"+ln.Addr().String(), []string{"*"}))
	t.Cleanup(proxy.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	start := time.Now()
	_, resp, err := websocket.Dial(ctx, "ws://"+proxy.Listener.Addr().String()+"/rtc", nil)
	if err == nil {
		t.Fatal("dial succeeded against a silent backend")
	}
	if resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("resp = %v, err = %v; want 502", resp, err)
	}
	_ = resp.Body.Close()
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("proxy answered after %v, want about the 200 ms dial bound", elapsed)
	}
}

func TestTruncateCloseReason(t *testing.T) {
	if got := api.TruncateCloseReasonForTest(strings.Repeat("é", 100)); got != strings.Repeat("é", 61) {
		t.Fatalf("truncated to %d bytes %q, want 61 whole runes (122 bytes)", len(got), got)
	}
	if got := api.TruncateCloseReasonForTest("ok"); got != "ok" {
		t.Fatalf("short reason changed to %q", got)
	}
}

func TestSendableCloseCode(t *testing.T) {
	for code, want := range map[websocket.StatusCode]bool{
		websocket.StatusNormalClosure: true, websocket.StatusGoingAway: true, websocket.StatusBadGateway: true,
		3000: true, 4999: true, 1004: false, websocket.StatusNoStatusRcvd: false,
		websocket.StatusAbnormalClosure: false, websocket.StatusTLSHandshake: false, 999: false, 5000: false, 1016: false,
	} {
		if got := api.SendableCloseCodeForTest(code); got != want {
			t.Errorf("sendableCloseCode(%d) = %v, want %v", code, got, want)
		}
	}
}
