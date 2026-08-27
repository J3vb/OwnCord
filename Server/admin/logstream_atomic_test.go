package admin

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// handleLogStream's backfill loop does a DB round-trip per entry between
// taking the snapshot and registering the live subscription — Snapshot()
// followed by a separate Subscribe() call left a window where a write in
// between landed in neither (v059). SnapshotAndSubscribe closes that window
// by doing both under one lock acquisition.
func TestRingBuffer_SnapshotAndSubscribe_NoGap(t *testing.T) {
	buf := NewRingBuffer(10)
	buf.Write(LogEntry{Message: "before"})

	snap, ch, unsub := buf.SnapshotAndSubscribe()
	defer unsub()

	if len(snap) != 1 || snap[0].Message != "before" {
		t.Fatalf("snapshot = %+v, want [{Message: before}]", snap)
	}

	// A write that lands after the atomic call returns must reach the
	// channel — it is neither in the snapshot nor lost.
	buf.Write(LogEntry{Message: "after"})

	select {
	case e := <-ch:
		if e.Message != "after" {
			t.Fatalf("got %+v, want Message=after", e)
		}
	default:
		t.Fatal("expected the post-subscribe write to be delivered on the channel, got nothing")
	}
}

// The snapshot and the subscription returned by SnapshotAndSubscribe must
// still behave like independently-called Snapshot/Subscribe: entries already
// in the ring appear in the snapshot, not replayed on the channel.
func TestRingBuffer_SnapshotAndSubscribe_SnapshotExcludedFromChannel(t *testing.T) {
	buf := NewRingBuffer(10)
	buf.Write(LogEntry{Message: "already-in-ring"})

	snap, ch, unsub := buf.SnapshotAndSubscribe()
	defer unsub()

	if len(snap) != 1 {
		t.Fatalf("snapshot = %+v, want 1 entry", snap)
	}
	select {
	case e := <-ch:
		t.Fatalf("channel should not replay pre-existing entries, got %+v", e)
	default:
	}
}

// gapProbeSSEWriter drives the handler from inside its own writes: the first
// backfilled entry triggers onFirstBackfill (which writes a fresh log line,
// i.e. exactly the interleaving the gap loses), and once wantData entries have
// been written the request context is cancelled so the handler returns.
type gapProbeSSEWriter struct {
	header          http.Header
	statusCode      int
	dataWrites      int
	wantData        int
	buffer          bytes.Buffer
	onFirstBackfill func()
	cancel          func()
}

func (w *gapProbeSSEWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *gapProbeSSEWriter) WriteHeader(statusCode int) { w.statusCode = statusCode }
func (w *gapProbeSSEWriter) Flush()                     {}

func (w *gapProbeSSEWriter) Write(data []byte) (int, error) {
	_, _ = w.buffer.Write(data)
	if bytes.Contains(data, []byte("data: ")) {
		w.dataWrites++
		if w.dataWrites == 1 && w.onFirstBackfill != nil {
			w.onFirstBackfill()
		}
		if w.dataWrites >= w.wantData && w.cancel != nil {
			w.cancel()
		}
	}
	return len(data), nil
}

// The end-to-end shape of v059: a log line written *while the backfill loop is
// running* must still reach the stream. Under the old Snapshot()-then-
// Subscribe() ordering it was in neither — the snapshot predated it and the
// subscription did not exist yet — and this test hits that window
// deterministically by doing the write from inside the first backfill entry's
// Write call.
func TestHandleLogStream_EntryWrittenDuringBackfillIsDelivered(t *testing.T) {
	database := newLogStreamTestDB(t)
	logBuf := NewRingBuffer(8)
	logBuf.Write(LogEntry{Timestamp: "2026-08-07T10:00:00Z", Level: "info", Message: "backfill-one", Source: "test"})
	logBuf.Write(LogEntry{Timestamp: "2026-08-07T10:00:01Z", Level: "info", Message: "backfill-two", Source: "test"})

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

	// The timeout is the failure path only: with the gap open the third entry
	// never arrives, so nothing would ever cancel the stream.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+ticket, nil).WithContext(ctx)
	writer := &gapProbeSSEWriter{
		header:   make(http.Header),
		wantData: 3,
		cancel:   cancel,
		onFirstBackfill: func() {
			logBuf.Write(LogEntry{Timestamp: "2026-08-07T10:00:02Z", Level: "warn", Message: "written-during-backfill", Source: "test"})
		},
	}

	handleLogStream(database, logBuf).ServeHTTP(writer, req)

	if writer.statusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", writer.statusCode, writer.buffer.String())
	}
	if !strings.Contains(writer.buffer.String(), "written-during-backfill") {
		t.Fatalf("entry written during the backfill was lost from both the backfill and the live feed; body = %s", writer.buffer.String())
	}
}
