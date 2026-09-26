package ws

// serve_pumps_ping_test.go — CLI-01: the server's protocol Ping keeps a peer
// that answers Pings alive without any app-level traffic, and closes a peer
// that stops answering. The interval is scaled down; the ratios are what the
// production 25s interval gives (12 intervals ≈ 5 minutes, close ≤ 2 intervals).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testPingInterval = 50 * time.Millisecond

// startPingPumpServer accepts one connection, runs pingPump plus a read loop
// (the Pong is only processed by a concurrent Read, as readPump does in
// production) and reports when the server side's read ends.
func startPingPumpServer(t *testing.T, c *Client) (*websocket.Conn, <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	readDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		go pingPump(ctx, conn, c, testPingInterval)
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				break
			}
		}
		close(readDone)
		_ = conn.CloseNow()
	}))
	t.Cleanup(func() {
		cancel()
		srv.Close()
	})

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn, readDone
}

func TestPingPump_PongOnlyPeerStaysAlive(t *testing.T) {
	c := &Client{userID: 1, lastActivity: time.Now()}
	conn, readDone := startPingPumpServer(t, c)

	// The peer sends nothing; its Read loop only answers the server's Pings.
	peerCtx, peerCancel := context.WithCancel(context.Background())
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		_, _, _ = conn.Read(peerCtx)
	}()
	t.Cleanup(func() {
		peerCancel()
		<-peerDone
	})

	deadline := time.Now().Add(12 * testPingInterval)
	for time.Now().Before(deadline) {
		select {
		case <-readDone:
			t.Fatal("server closed a peer that answers every Ping")
		case <-time.After(testPingInterval):
		}
		if age := time.Since(c.getLastActivity()); age > 3*testPingInterval {
			t.Fatalf("Pongs did not refresh activity: last activity %v ago", age)
		}
	}
	if c.msgsReceived != 0 {
		t.Fatalf("a Pong counted as a received message: msgsReceived=%d", c.msgsReceived)
	}
}

func TestPingPump_SilentPeerClosed(t *testing.T) {
	c := &Client{userID: 1, lastActivity: time.Now()}
	// The peer never reads, so it never answers a Ping — a half-open socket.
	_, readDone := startPingPumpServer(t, c)

	start := time.Now()
	select {
	case <-readDone:
	case <-time.After(20 * testPingInterval):
		t.Fatal("server kept a peer that never answers a Ping")
	}
	// Due at 2 intervals; the slack absorbs -race scheduling.
	if took := time.Since(start); took > 6*testPingInterval {
		t.Fatalf("silent peer closed after %v, want about %v", took, 2*testPingInterval)
	}
}
