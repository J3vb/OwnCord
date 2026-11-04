package admin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// fakeClock is a manually advanced clock for the throttle tests.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func TestThrottledCheck_ChecksAtMostOncePerWindow(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	calls := 0
	check := throttledCheck(func() bool { calls++; return true }, time.Second, clock.now)

	for range 100 {
		clock.advance(5 * time.Millisecond)
		if !check() {
			t.Fatal("check reported false while the viewer is still authorized")
		}
	}
	if calls != 0 {
		t.Fatalf("100 calls inside the window made %d real checks, want 0 (seeded by the initial authorization)", calls)
	}

	clock.advance(time.Second)
	if !check() || calls != 1 {
		t.Fatalf("after the window: calls = %d, want 1", calls)
	}
	for range 100 {
		check()
	}
	if calls != 1 {
		t.Fatalf("calls inside the next window = %d, want still 1", calls)
	}
}

func TestThrottledCheck_FalseIsPermanent(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	calls := 0
	check := throttledCheck(func() bool { calls++; return false }, time.Second, clock.now)

	clock.advance(2 * time.Second)
	if check() {
		t.Fatal("check returned true after the underlying check failed")
	}
	clock.advance(time.Hour)
	for range 2 {
		if check() {
			t.Fatal("check returned true after it had already denied")
		}
	}
	if calls != 1 {
		t.Fatalf("underlying check called %d times, want 1", calls)
	}
}

// streamSessionTicket creates a user with a session and returns the session's
// token hash and a ticket for the log stream.
func streamSessionTicket(t *testing.T, database *db.DB) (tokenHash, ticket string) {
	t.Helper()
	userID, err := database.CreateUser(context.Background(), "owner", "hash", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	token, err := auth.GenerateToken()
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	tokenHash = auth.HashToken(token)
	if _, err := database.CreateSession(context.Background(), userID, tokenHash, "test", "127.0.0.1"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	ticket, err = logTickets.issue(tokenHash)
	if err != nil {
		t.Fatalf("issue ticket: %v", err)
	}
	return tokenHash, ticket
}

// A burst of 60 live lines inside one second costs no extra resolutions: only the
// initial authorization and the backfill chunk check. Once the clock passes the
// window, the next line re-checks.
func TestHandleLogStream_BurstOfLinesReChecksOncePerSecond(t *testing.T) {
	database := newLogStreamTestDB(t)
	_, ticket := streamSessionTicket(t, database)
	logBuf := fillRing(1, "2026-11-04T10:00:00Z")

	var resolves atomic.Int64
	var nowNanos atomic.Int64
	base := time.Unix(2000, 0)
	nowNanos.Store(base.UnixNano())
	hooks := logStreamHooks{
		now:       func() time.Time { return time.Unix(0, nowNanos.Load()) },
		onResolve: func() { resolves.Add(1) },
	}

	// 60 lines fit the subscriber channel (64), so none are dropped.
	const burst = 60
	var afterBurst int64
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+ticket, nil).WithContext(ctx)
	writer := &sseProbe{
		header: make(http.Header),
		onData: func(n int) {
			switch n {
			case 1: // the backfill chunk
				for i := range burst {
					logBuf.Write(LogEntry{Level: "INFO", Message: "burst " + strconv.Itoa(i)})
				}
			case 1 + burst: // the last burst line has been forwarded
				afterBurst = resolves.Load()
				nowNanos.Store(base.Add(2 * time.Second).UnixNano())
				logBuf.Write(LogEntry{Level: "INFO", Message: "later"})
			case 2 + burst:
				cancel()
			}
		},
	}

	handleLogStreamWith(database, logBuf, hooks).ServeHTTP(writer, req)

	if afterBurst > 2 {
		t.Fatalf("a burst of lines cost %d resolutions, want at most 2 (initial check plus backfill chunk)", afterBurst)
	}
	if got := resolves.Load(); got <= afterBurst {
		t.Fatalf("the first line after the window did not re-check: resolutions %d then %d", afterBurst, got)
	}
}

// Revoking the session mid-stream ends the stream within about the re-check
// window, even though lines keep arriving.
func TestHandleLogStream_RevocationEndsLiveStreamWithinWindow(t *testing.T) {
	database := newLogStreamTestDB(t)
	tokenHash, ticket := streamSessionTicket(t, database)
	logBuf := fillRing(1, "2026-11-04T10:00:00Z")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, "/logs/stream?ticket="+ticket, nil).WithContext(ctx)

	var revokedAt time.Time
	writer := &sseProbe{
		header: make(http.Header),
		onData: func(n int) {
			if n == 1 {
				if err := database.DeleteSession(context.Background(), tokenHash); err != nil {
					t.Errorf("DeleteSession: %v", err)
					return
				}
				revokedAt = time.Now()
			}
			// Keep the stream busy: one more line every 50 ms.
			time.Sleep(50 * time.Millisecond)
			logBuf.Write(LogEntry{Level: "INFO", Message: "line " + strconv.Itoa(n)})
		},
	}

	handleLogStream(database, logBuf).ServeHTTP(writer, req)

	if ctx.Err() != nil {
		t.Fatal("stream was still open after the session was revoked")
	}
	if took := time.Since(revokedAt); took > 3*time.Second {
		t.Fatalf("stream took %v to end after revocation, want about one second", took)
	}
}

// A viewer that falls behind is told how many lines it missed, in its own feed
// only.
func TestRingBuffer_SlowSubscriberGetsSkippedMarker(t *testing.T) {
	rb := NewRingBuffer(256)
	ch, unsub := rb.Subscribe()
	defer unsub()

	for i := range 64 {
		rb.Write(LogEntry{Level: "INFO", Message: "fill " + strconv.Itoa(i)})
	}
	for i := range 5 {
		rb.Write(LogEntry{Level: "INFO", Message: "dropped " + strconv.Itoa(i)})
	}
	for range 64 {
		<-ch
	}
	rb.Write(LogEntry{Level: "INFO", Message: "after"})

	marker := <-ch
	if marker.Message != "5 lines skipped (viewer fell behind)" || marker.Level != "WARN" || marker.Source != "admin" {
		t.Fatalf("marker = %+v", marker)
	}
	if next := <-ch; next.Message != "after" {
		t.Fatalf("entry after the marker = %q, want \"after\"", next.Message)
	}
	for _, e := range rb.Snapshot() {
		if e.Source == "admin" && e.Level == "WARN" {
			t.Fatalf("marker leaked into the ring: %+v", e)
		}
	}
	if len(rb.Snapshot()) != 70 {
		t.Fatalf("ring holds %d entries, want 70", len(rb.Snapshot()))
	}
}

// A viewer that frees one slot at a time still gets real lines, not a run of
// markers that each push out the line behind them.
func TestRingBuffer_ViewerFreeingOneSlotStillGetsLines(t *testing.T) {
	rb := NewRingBuffer(256)
	ch, unsub := rb.Subscribe()
	defer unsub()

	for i := range 65 {
		rb.Write(LogEntry{Level: "INFO", Message: "fill " + strconv.Itoa(i)})
	}
	var got []LogEntry
	for i := range 10 {
		got = append(got, <-ch)
		rb.Write(LogEntry{Level: "INFO", Message: "live " + strconv.Itoa(i)})
	}
	for len(ch) > 0 {
		got = append(got, <-ch)
	}
	live := 0
	for _, e := range got {
		if strings.HasPrefix(e.Message, "live ") {
			live++
		}
	}
	if live == 0 {
		t.Fatalf("viewer freeing one slot at a time got no live lines: %+v", got[len(got)-10:])
	}
}
