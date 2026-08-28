package admin

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

type revokingSSEWriter struct {
	header     http.Header
	statusCode int
	writeCount int
	revoke     func()
	cancel     func()
	buffer     bytes.Buffer
}

func (w *revokingSSEWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *revokingSSEWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
}

func (w *revokingSSEWriter) Write(data []byte) (int, error) {
	_, _ = w.buffer.Write(data)
	if bytes.Contains(data, []byte("data: ")) {
		w.writeCount++
		switch w.writeCount {
		case 1:
			if w.revoke != nil {
				w.revoke()
			}
		case 2:
			if w.cancel != nil {
				w.cancel()
			}
		}
	}
	return len(data), nil
}

func (w *revokingSSEWriter) Flush() {}

func newLogStreamTestDB(t *testing.T) *db.DB {
	t.Helper()

	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	return database
}

func TestHandleLogStream_BackfillStopsAfterSessionRevocation(t *testing.T) {
	database := newLogStreamTestDB(t)
	logBuf := NewRingBuffer(8)
	logBuf.Write(LogEntry{Timestamp: "2026-03-29T10:00:00Z", Level: "info", Message: "first", Source: "test"})
	logBuf.Write(LogEntry{Timestamp: "2026-03-29T10:00:01Z", Level: "info", Message: "second", Source: "test"})

	userID, err := database.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	ticket, err := logTickets.issue(tokenHash)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+ticket, nil).WithContext(ctx)
	writer := &revokingSSEWriter{
		header: make(http.Header),
		revoke: func() {
			_ = database.DeleteSession(context.Background(), tokenHash)
		},
		cancel: cancel,
	}

	handleLogStream(database, logBuf).ServeHTTP(writer, req)

	if writer.statusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", writer.statusCode, writer.buffer.String())
	}
	if writer.writeCount != 1 {
		t.Fatalf("expected backfill to stop after first entry once session was revoked, wrote %d entries; body = %s", writer.writeCount, writer.buffer.String())
	}
}

func TestHandleLogStream_BackfillStopsAfterAPITokenRevocation(t *testing.T) {
	database := newLogStreamTestDB(t)
	logBuf := NewRingBuffer(8)
	logBuf.Write(LogEntry{Timestamp: "2026-07-31T10:00:00Z", Level: "info", Message: "first", Source: "test"})
	logBuf.Write(LogEntry{Timestamp: "2026-07-31T10:00:01Z", Level: "info", Message: "second", Source: "test"})

	userID, err := database.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	tokenID, err := database.CreateAPIToken(context.Background(), userID, tokenHash, "test", nil)
	if err != nil {
		t.Fatalf("CreateAPIToken: %v", err)
	}

	ticket, err := logTickets.issue(tokenHash)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+ticket, nil).WithContext(ctx)
	writer := &revokingSSEWriter{
		header: make(http.Header),
		revoke: func() {
			_, _ = database.RevokeAPIToken(context.Background(), tokenID)
		},
		cancel: cancel,
	}

	handleLogStream(database, logBuf).ServeHTTP(writer, req)

	if writer.statusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", writer.statusCode, writer.buffer.String())
	}
	if writer.writeCount != 1 {
		t.Fatalf("expected backfill to stop after first entry once the API token was revoked, wrote %d entries; body = %s", writer.writeCount, writer.buffer.String())
	}
}

// TestHandleLogStream_SurvivesServerWriteTimeout pins the bug described in
// OC-0013: the handler writes SSE through the ordinary ResponseWriter (no
// Hijack), so on a real http.Server the connection's write deadline is set
// exactly once, when headers are read (net/http's conn.readRequest), from
// srv.WriteTimeout. Nothing in the handler extends that deadline, so once it
// elapses every further write on the connection silently times out (the
// handler discards write errors) and the client stops receiving anything.
//
// This must run against a real http.Server (httptest.NewUnstartedServer),
// not httptest.NewRequest/httptest.ResponseRecorder, because a
// ResponseRecorder has no underlying connection to enforce a write deadline
// on and so cannot reproduce the failure.
func TestHandleLogStream_SurvivesServerWriteTimeout(t *testing.T) {
	database := newLogStreamTestDB(t)
	logBuf := NewRingBuffer(64)

	userID, err := database.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	ticket, err := logTickets.issue(tokenHash)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/logs/stream", handleLogStream(database, logBuf))

	srv := httptest.NewUnstartedServer(mux)
	// A short stand-in for main.go's srv.WriteTimeout: 30 * time.Second, so
	// the test doesn't have to wait 30s for the deadline to elapse.
	srv.Config.WriteTimeout = 200 * time.Millisecond
	srv.Start()
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/logs/stream?ticket=" + ticket)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	// Let the connection's write deadline (set once, at request-header time)
	// elapse before asking the handler to write anything else.
	time.Sleep(400 * time.Millisecond)

	logBuf.Write(LogEntry{Timestamp: "2026-08-15T00:00:00Z", Level: "info", Message: "after-timeout", Source: "test"})

	type readResult struct {
		data []byte
		err  error
	}
	resultCh := make(chan readResult, 1)
	body := resp.Body
	go func() {
		buf := make([]byte, 4096)
		n, rerr := body.Read(buf)
		resultCh <- readResult{data: buf[:n], err: rerr}
	}()

	select {
	case res := <-resultCh:
		if res.err != nil {
			t.Fatalf("expected the post-timeout log entry to be delivered, got a read error instead (connection was severed by WriteTimeout): %v", res.err)
		}
		if !bytes.Contains(res.data, []byte("after-timeout")) {
			t.Fatalf("expected the post-timeout entry in the stream, got: %q", res.data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for the post-WriteTimeout log entry; stream appears severed by http.Server.WriteTimeout")
	}
}
