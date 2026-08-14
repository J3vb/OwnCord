package ws

// serve_reconnect_double_teardown_test.go — regression test for OC-0051.
//
// unregisterFailedHandshake's doc comment (serve.go:412-414) claims "No
// readPump ever starts for this connection" — true on the fresh-connect
// branch (handleFreshConnect returns an error and ServeWS returns without
// starting pumps) but false on the reconnect branch: handleReconnect ran the
// full unregisterFailedHandshake teardown itself on a handshake-write
// failure and then returned true, which ServeWS reads as "success, start the
// pumps" (serve.go:69-72). readPump then runs against the already-closed
// conn, fails its first Read, and its defer runs the SAME disconnect
// teardown a second time — a second MarkUserDisconnected and a second
// offline presence broadcast for a connection that was already torn down.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
)

// TestHandleReconnect_HandshakeWriteFailure_TearsDownOnlyOnce locks OC-0051:
// a failed auth_ok write on the reconnect path must result in exactly one
// offline-presence broadcast, however ServeWS reacts to handleReconnect's
// return value.
func TestHandleReconnect_HandshakeWriteFailure_TearsDownOnlyOnce(t *testing.T) {
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	ctx := context.Background()
	userID, err := database.CreateUser(ctx, "reconnect-write-fail", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, userID, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	// Run is deliberately not started so h.broadcast can be drained directly,
	// matching the convention in serve_failed_handshake_teardown_test.go.
	h := NewHub(database, auth.NewRateLimiter(), nil)

	// Seed the ring buffer so the reconnect replay succeeds from the buffer
	// tier: lastSeq=2 sits strictly between oldestSeq(1) and newestSeq(3).
	rb := h.ReplayBuffer()
	rb.Push(1, 0, []byte(`{"seq":1,"type":"broadcast"}`))
	rb.Push(2, 0, []byte(`{"seq":2,"type":"broadcast"}`))
	rb.Push(3, 0, []byte(`{"seq":3,"type":"broadcast"}`))

	c := NewTestClient(h, userID, make(chan []byte, 8))
	c.user = &db.User{ID: userID, Status: "online"}
	c.lastSeq = 2

	// A real server-side *websocket.Conn, closed before handleReconnect ever
	// writes to it — reproducing "peer already gone / write timeout" from the
	// finding's repro without relying on network timing.
	connCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		// CloseNow (not Close) — Close performs a close handshake that blocks
		// up to 5s waiting for a reply the unread client connection below
		// never sends. CloseNow just tears down the underlying net.Conn, which
		// is all this test needs to make the next Write on conn fail.
		_ = conn.CloseNow()
		connCh <- conn
	}))
	defer srv.Close()

	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	clientConn, resp, dialErr := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if dialErr != nil {
		t.Fatalf("dial: %v", dialErr)
	}
	defer func() { _ = clientConn.Close(websocket.StatusNormalClosure, "") }()

	var conn *websocket.Conn
	select {
	case conn = <-connCh:
	case <-time.After(5 * time.Second):
		t.Fatal("server never accepted the connection")
	}

	// handleReconnect: replay succeeds (buffer tier), but the auth_ok write
	// fails because conn is already closed — the handshake-write-failure
	// branch runs and performs the full teardown itself, then reports
	// startPumps=false so ServeWS (serve.go:69-74) does not start readPump on
	// top of it. Mirror that gating here: readPump must run only when
	// startPumps says so.
	handled, startPumps := h.handleReconnect(ctx, conn, c, database, c.lastSeq)
	if !handled {
		t.Fatal("precondition: replay must succeed so the write-failure branch (not the fall-through-to-full-ready branch) runs")
	}
	if startPumps {
		t.Error("handleReconnect reported startPumps=true after a handshake write failure — its own teardown already ran, so ServeWS starting the pumps would run it again")
		readPump(ctx, conn, h, c)
	}

	var offlineBroadcasts int
	for len(h.broadcast) > 0 {
		bm := <-h.broadcast
		if bytes.Contains(bm.msg, []byte(`"status":"offline"`)) {
			offlineBroadcasts++
		}
	}
	if offlineBroadcasts != 1 {
		t.Errorf("got %d offline presence broadcasts after a failed reconnect handshake write, want exactly 1", offlineBroadcasts)
	}
}
