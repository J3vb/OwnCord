package ws

// serve_pumps_priority_test.go — regression test for finding v089: writePump's
// blocking select used to list sendHigh, send, and sendLow as peer cases, so
// Go's uniformly-random selection among ready channels let a queued
// low-priority frame (typing/presence) win the race against a queued normal
// frame (chat/reactions) roughly half the time — contradicting the function's
// own documented "low only when no higher-priority work is pending" contract.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestWritePump_DrainsAllNormalBeforeAnyLow pre-queues N low-priority frames
// and N normal-priority frames on open (not yet closed) channels before
// writePump's loop can run at all, then reads all 2N frames back. If low ever
// won a coin flip against normal — the pre-fix behavior, since sendLow was a
// peer case in the very same blocking select as send — a typing frame would
// show up before some chat_message frame.
//
// The channels are deliberately left open (not closeSend'd) for the body of
// the test: a closed channel is always "select-ready", so closing before the
// pump starts would make its Priority-1 check immediately see sendHigh as
// ready-with-ok=false and short-circuit straight into drainAndClose, which
// drains each channel to completion in a fixed order — masking the exact
// per-message race this test exists to catch. The context is canceled only
// after every frame is read, so the pump exits cleanly via ctx.Done()
// instead of leaking (caught by TestMain's goleak check) or taking that
// shortcut.
func TestWritePump_DrainsAllNormalBeforeAnyLow(t *testing.T) {
	const n = 200

	c := &Client{
		userID:   1,
		send:     make(chan []byte, n),
		sendHigh: make(chan []byte, n),
		sendLow:  make(chan []byte, n),
	}
	for i := range n {
		c.sendLow <- []byte(`{"type":"typing","seq":` + strconv.Itoa(i) + `}`)
	}
	for i := range n {
		c.send <- []byte(`{"type":"chat_message","seq":` + strconv.Itoa(i) + `}`)
	}

	pumpCtx, pumpCancel := context.WithCancel(context.Background())
	defer pumpCancel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, acceptErr := websocket.Accept(w, r, nil)
		if acceptErr != nil {
			return
		}
		writePump(pumpCtx, conn, c)
		// writePump only returns on ctx.Done() here (the test cancels pumpCtx
		// once every frame is read) — nobody else closes the connection, so
		// do it explicitly rather than leaving the client's own Close to wait
		// out a full close-handshake timeout against a peer that already hung
		// up its handler.
		_ = conn.CloseNow()
	}))
	defer srv.Close()

	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer dialCancel()
	conn, resp, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	sawLow := false
	for i := range 2 * n {
		readCtx, readCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, msg, readErr := conn.Read(readCtx)
		readCancel()
		if readErr != nil {
			t.Fatalf("frame %d: read: %v", i, readErr)
		}
		switch {
		case strings.Contains(string(msg), "typing"):
			sawLow = true
		case strings.Contains(string(msg), "chat_message"):
			if sawLow {
				t.Fatalf("frame %d: normal-priority frame arrived after a low-priority one: %s", i, msg)
			}
		default:
			t.Fatalf("frame %d: unexpected payload: %s", i, msg)
		}
	}
	if !sawLow {
		t.Fatal("never observed a low-priority frame — test setup is broken")
	}

	// Stop the pump cleanly via ctx.Done() now that every frame has been
	// read, instead of relying on drainAndClose (closeSend) to end the loop.
	pumpCancel()
}
