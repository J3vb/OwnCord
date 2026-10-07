package ws

// serve_pumps_fragment_test.go — a peer's Ping must be answered while the
// server is still writing a large message over a slow link. coder/websocket
// answers a Ping from inside conn.Read under a fixed 5s deadline and needs the
// frame write lock to do it; if one frame holds that lock for the whole large
// message, the Pong waits out the write, and past 5s readPump drops the session.

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// slowConn throttles writes to about 400 KB/s, a slow link.
type slowConn struct{ net.Conn }

func (s slowConn) Write(p []byte) (int, error) {
	n := 0
	for len(p) > 0 {
		k := min(len(p), 4<<10)
		time.Sleep(10 * time.Millisecond)
		w, err := s.Conn.Write(p[:k])
		n += w
		if err != nil {
			return n, err
		}
		p = p[k:]
	}
	return n, nil
}

type slowListener struct{ net.Listener }

func (l slowListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return slowConn{c}, nil
}

func TestWritePumpWrite_PeerPingAnsweredDuringLargeMessage(t *testing.T) {
	msg := bytes.Repeat([]byte("x"), 1<<20) // about 2.6s on the slow link

	srvCtx, srvCancel := context.WithCancel(context.Background())
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.CloseNow() }()
		// The Pong is written from inside Read, as in readPump.
		go func() {
			for {
				if _, _, err := conn.Read(srvCtx); err != nil {
					return
				}
			}
		}()
		writePumpWrite(newWriteDeadline(srvCtx, writeTimeout), conn, &Client{userID: 1}, msg)
		<-srvCtx.Done()
	}))
	srv.Listener = slowListener{srv.Listener}
	srv.Start()
	t.Cleanup(func() {
		srvCancel()
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
	defer func() { _ = conn.CloseNow() }()
	conn.SetReadLimit(int64(len(msg)) + 1)

	got := make(chan []byte, 1)
	go func() {
		readCtx, readCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer readCancel()
		_, data, _ := conn.Read(readCtx)
		got <- data
	}()

	time.Sleep(300 * time.Millisecond) // the large message is mid-write
	pingCtx, pingCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pingCancel()
	start := time.Now()
	if err := conn.Ping(pingCtx); err != nil {
		t.Fatalf("ping during a large message: %v", err)
	}
	if rtt := time.Since(start); rtt > time.Second {
		t.Fatalf("Pong waited %v for the large message's write to finish", rtt)
	}

	select {
	case data := <-got:
		if !bytes.Equal(data, msg) {
			t.Fatalf("fragmented message arrived as %d bytes, want %d", len(data), len(msg))
		}
	case <-time.After(20 * time.Second):
		t.Fatal("large message never arrived")
	}
}
