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

// A timer that fires just as a write succeeds cancels the shared context even
// though the write returned nil. The next frame must still go out on the same
// healthy connection rather than failing on the poisoned context.
func TestWriteDeadline_LateTimerDoesNotPoisonNextWrite(t *testing.T) {
	result := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		wd := newWriteDeadline(r.Context(), time.Hour)
		defer wd.stop()
		if err := wd.write(conn, []byte("first")); err != nil {
			result <- err
			return
		}
		wd.timer.Reset(time.Millisecond)
		<-wd.ctx.Done()
		result <- wd.write(conn, []byte("second"))
	}))
	defer srv.Close()
	conn := dialTestConn(t, srv.URL)
	defer func() { _ = conn.CloseNow() }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, want := range []string{"first", "second"} {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read %q: %v", want, err)
		}
		if string(msg) != want {
			t.Fatalf("got %q want %q", msg, want)
		}
	}
	if err := <-result; err != nil {
		t.Fatalf("write after late timer: %v", err)
	}
}

// The timer fires while a write succeeds but its AfterFunc goroutine has not
// cancelled yet: Stop reports false with a nil error, and the delayed cancel
// lands during the next write. write must have swapped in a fresh context by
// then. Unlike the test above this never waits for ctx.Done, so the pre-write
// check cannot repair it and only the post-write reset keeps the frame alive.
func TestWriteDeadline_TimerFiredDuringSuccessfulWriteIsReset(t *testing.T) {
	result := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		wd := newWriteDeadline(r.Context(), time.Hour)
		defer wd.stop()
		var late context.CancelFunc
		wd.writeFn = func(ctx context.Context, c *websocket.Conn, msg []byte) error {
			err := writeFragmented(ctx, c, msg)
			// Stop first so the real AfterFunc never runs: write's own Stop
			// then returns false, exactly as for a fired timer.
			wd.timer.Stop()
			late = wd.cancel
			return err
		}
		if err := wd.write(conn, []byte("first")); err != nil {
			result <- err
			return
		}
		wd.writeFn = func(ctx context.Context, c *websocket.Conn, msg []byte) error {
			late() // the delayed cancel lands mid-write
			return writeFragmented(ctx, c, msg)
		}
		result <- wd.write(conn, []byte("second"))
	}))
	defer srv.Close()
	conn := dialTestConn(t, srv.URL)
	defer func() { _ = conn.CloseNow() }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, want := range []string{"first", "second"} {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read %q: %v", want, err)
		}
		if string(msg) != want {
			t.Fatalf("got %q want %q", msg, want)
		}
	}
	if err := <-result; err != nil {
		t.Fatalf("write after late cancel: %v", err)
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
		// Answer the close frame so the close handshake stays outside the
		// timed region; without this writePump waits out the close timeout.
		if _, _, err := conn.Read(context.Background()); err == nil {
			b.Fatal("expected the close error after the last frame")
		}
		<-done
		_ = conn.CloseNow()
		srv.Close()
	}
}
