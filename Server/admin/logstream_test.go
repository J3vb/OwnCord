package admin

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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

	userID, err := database.CreateUser("owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash := auth.HashToken(token)
	if _, err := database.CreateSession(userID, tokenHash, "test", "127.0.0.1"); err != nil {
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
			_ = database.DeleteSession(tokenHash)
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
