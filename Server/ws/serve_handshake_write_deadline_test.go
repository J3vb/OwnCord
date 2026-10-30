package ws_test

// serve_handshake_write_deadline_test.go pins OC-0152: every handshake write
// in serve.go (auth_ok / ready / reconnect replay) is issued with the bare
// r.Context() instead of a bounded write context. websocket.Accept hijacks the
// connection, which stops net/http's own read loop from ever cancelling that
// context, so coder/websocket's Conn.Write blocks on the underlying socket
// write forever once a stalled peer's receive window and the server's send
// buffer fill — pinning the handler goroutine, the client's slot in the hub,
// and the file descriptor for good.
//
// The test shrinks both sides' TCP socket buffers to the kernel minimum (so
// a bounded amount of unread traffic is enough to make the write block, no
// megabyte-scale burst required) and seeds enough members that the ready
// payload alone comfortably exceeds that minimum. It then dials, completes
// auth, and never reads another byte. Registration happens before the
// handshake writes (serve.go), so hub.ClientCount() drops back to 0 only once
// the blocked write returns — with a deadline, that happens once writeTimeout
// elapses; without one, it never happens and the poll loop below times out.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/ws"
)

// tinySendBufListener wraps a net.Listener and shrinks SO_SNDBUF on every
// accepted connection to the kernel minimum, so the server's handshake writes
// cannot buffer their way past a peer that stops reading.
type tinySendBufListener struct {
	net.Listener
}

func (l *tinySendBufListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetWriteBuffer(1) // kernel clamps this up to its own floor
	}
	return c, nil
}

// TestServeWS_HandshakeWrite_TimesOutOnStalledPeer pins OC-0152. It fails
// against the pre-fix code and passes once every handshake write is wrapped
// in a bounded write context.
//
// The two buffer-shrinking tricks below (tinySendBufListener +
// SetReadBuffer) don't produce a truly infinite block in this sandbox's
// network stack — TCP window mechanics still let bytes trickle through
// eventually even though nothing ever calls Read. What they reliably produce
// is a large, measurable slowdown: a ~500KB ready payload measured well
// north of 30s to complete against the pre-fix code in this environment,
// against a fixed writeTimeout of 10s. So instead of asserting "never
// returns", the test asserts the behavior the fix is actually supposed to
// guarantee: the handshake resolves (success or failure) within
// writeTimeout-plus-margin. That holds post-fix regardless of payload size
// (the AfterFunc-driven close fires at the deadline no matter how much data
// is still queued) and fails pre-fix for any payload large enough to still
// be in flight at that point — which the member count below is sized well
// past, for margin.
func TestServeWS_HandshakeWrite_TimesOutOnStalledPeer(t *testing.T) {
	database := openServeTestDB(t)
	limiter := auth.NewRateLimiter()
	hub := newTestHubDeps(t, database, limiter, nil)
	go hub.Run()
	defer hub.Stop()

	// Seed enough members that the ready payload takes long enough to
	// trickle through the shrunk buffers below that it is still in flight
	// well past writeTimeout — see the function doc for why this needs to
	// be "slow enough to still be running at the deadline", not "infinite".
	for i := range 4000 {
		if _, err := database.CreateUser(context.Background(), fmt.Sprintf("bulk-member-%d", i), "hash", 1); err != nil {
			t.Fatalf("CreateUser(bulk-member-%d): %v", i, err)
		}
	}

	// Seed the connecting user's own session.
	userID, err := database.CreateUser(context.Background(), "stalled-peer-user", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	if _, err := database.CreateSession(context.Background(), userID, auth.HashToken(token), "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	handler := ws.ServeWS(hub, []string{"*"}, 0)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	srv := httptest.NewUnstartedServer(handler)
	_ = srv.Listener.Close()
	srv.Listener = &tinySendBufListener{Listener: ln}
	srv.Start()
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	// Custom HTTP client that shrinks SO_RCVBUF on the dial connection to the
	// kernel minimum, so this "peer" advertises a tiny receive window once it
	// stops draining it.
	dialer := &net.Dialer{}
	httpClient := &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				c, dialErr := dialer.DialContext(ctx, network, addr)
				if dialErr != nil {
					return nil, dialErr
				}
				if tc, ok := c.(*net.TCPConn); ok {
					_ = tc.SetReadBuffer(1) // kernel clamps this up to its own floor
				}
				return c, nil
			},
		},
	}

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dialCtx, wsURL, &websocket.DialOptions{HTTPClient: httpClient})
	if resp != nil && resp.Body != nil {
		defer func() { _ = resp.Body.Close() }()
	}
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer func() { _ = conn.Close(websocket.StatusInternalError, "test done") }()

	authMsg := map[string]any{
		"type":    "auth",
		"payload": map[string]string{"token": token},
	}
	raw, _ := json.Marshal(authMsg)
	authCtx, authCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer authCancel()
	if err := conn.Write(authCtx, websocket.MessageText, raw); err != nil {
		t.Fatalf("write auth: %v", err)
	}

	// Read auth_ok (small — writes/reads quickly regardless of the buffer
	// shrinking below) so that by the time we start the stall phase,
	// registration has DEFINITELY already happened (registerNow runs before
	// any handshake write — serve.go). Without this, polling ClientCount()
	// immediately after sending auth races the server's own goroutine
	// scheduling: an early poll can observe ClientCount()==0 simply because
	// registration hasn't happened *yet*, producing a false pass unrelated to
	// OC-0152 on both the buggy and the fixed code.
	readCtx, readCancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer readCancel()
	_, authOKRaw, err := conn.Read(readCtx)
	if err != nil {
		t.Fatalf("read auth_ok: %v", err)
	}
	var authOK struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(authOKRaw, &authOK); err != nil || authOK.Type != "auth_ok" {
		t.Fatalf("expected auth_ok, got %q (unmarshal err %v)", authOKRaw, err)
	}
	if hub.ClientCount() != 1 {
		t.Fatalf("ClientCount = %d right after auth_ok, want 1 (registration happens before this write)", hub.ClientCount())
	}

	// From here on the test deliberately never reads another frame — this is
	// the stalled peer. The next handshake write is the ready payload; a
	// ClientCount of 1 below just means that write is still in flight, and
	// can only fall back to 0 once it returns (success or, post-fix, timeout)
	// and the failed-handshake teardown runs.
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == 0 {
			return // handshake write returned (timed out) and cleaned up — fixed.
		}
		time.Sleep(100 * time.Millisecond)
	}

	t.Fatalf("OC-0152: handshake write to a stalled peer did not resolve within %v of writeTimeout margin — "+
		"ClientCount is still %d, meaning the write is bound to the bare request "+
		"context (never cancelled while the handler blocks in it) instead of a "+
		"writeTimeout-bounded one", 15*time.Second, hub.ClientCount())
}
