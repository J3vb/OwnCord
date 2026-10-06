package ws

// serve_pumps_deadline_test.go — P5-O04: writePump reuses one cancellable
// context and one resettable timer for every frame instead of paying a
// context.WithTimeout (propagateCancel + Deadline) per frame. The deadline
// stays per frame: a stalled peer still fails a write after the timeout, and an
// idle gap between frames never counts against the next write.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func dialTestConn(t testing.TB, srvURL string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srvURL, "http"), nil)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.SetReadLimit(-1)
	return conn
}

// A peer that never reads must fail a write once the per-frame timeout passes.
func TestWriteDeadline_StalledPeerTimesOut(t *testing.T) {
	result := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		wd := newWriteDeadline(r.Context(), 200*time.Millisecond)
		defer wd.stop()
		big := bytes.Repeat([]byte("x"), 1<<20)
		for {
			if err := wd.write(conn, big); err != nil {
				result <- err
				return
			}
		}
	}))
	defer srv.Close()
	conn := dialTestConn(t, srv.URL) // dialed, never read
	defer func() { _ = conn.CloseNow() }()

	select {
	case err := <-result:
		if err == nil {
			t.Fatal("expected a write error")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("write to a stalled peer never timed out")
	}
}

// An idle gap longer than the timeout between frames must not poison the next
// write — the timer only runs while a write is in flight.
func TestWriteDeadline_IdleGapDoesNotExpire(t *testing.T) {
	result := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		wd := newWriteDeadline(r.Context(), 100*time.Millisecond)
		defer wd.stop()
		if err := wd.write(conn, []byte("a")); err != nil {
			result <- err
			return
		}
		time.Sleep(300 * time.Millisecond)
		result <- wd.write(conn, []byte("b"))
	}))
	defer srv.Close()
	conn := dialTestConn(t, srv.URL)
	defer func() { _ = conn.CloseNow() }()

	if err := <-result; err != nil {
		t.Fatalf("write after idle gap: %v", err)
	}
}

func queuedClient(n int) *Client {
	c := &Client{
		userID:   1,
		send:     make(chan []byte, n),
		sendHigh: make(chan []byte, n),
		sendLow:  make(chan []byte, n),
	}
	for i := range n {
		c.send <- []byte(`{"type":"chat_message","seq":` + strconv.Itoa(i) + `}`)
	}
	return c
}

// 1,000 queued frames arrive in order, then closeSend flushes and closes.
func TestWritePump_DeliversQueuedFramesInOrder(t *testing.T) {
	const n = 1000
	c := queuedClient(n)
	c.closeSend()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		writePump(r.Context(), conn, c)
	}))
	defer srv.Close()
	conn := dialTestConn(t, srv.URL)
	defer func() { _ = conn.CloseNow() }()

	for i := range n {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, msg, err := conn.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if want := `{"type":"chat_message","seq":` + strconv.Itoa(i) + `}`; string(msg) != want {
			t.Fatalf("frame %d: got %s want %s", i, msg, want)
		}
	}
}

// BenchmarkWritePumpDrain is one op = writePump flushing 1,000 queued frames to
// a reading peer; compare allocs/op and ns/op before and after P5-O04.
func BenchmarkWritePumpDrain(b *testing.B) {
	const n = 1000
	for range b.N {
		b.StopTimer()
		c := queuedClient(n)
		c.closeSend()
		done := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			b.StartTimer()
			writePump(r.Context(), conn, c)
			b.StopTimer()
			close(done)
		}))
		conn := dialTestConn(b, srv.URL)
		for range n {
			if _, _, err := conn.Read(context.Background()); err != nil {
				b.Fatal(err)
			}
		}
		<-done
		_ = conn.CloseNow()
		srv.Close()
	}
}
