package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// The multiHandler tees every server log record into the admin panel's live
// log stream. Eleven of its functions had no coverage — including Subscribe,
// which is what a connected admin's SSE session hangs off. A silent break here
// makes the log viewer look like a quiet server.

// newTeeLogger wires a logger through NewMultiHandler and returns the logger,
// the ring buffer it feeds, and an accessor for the stdout side.
func newTeeLogger(t *testing.T, minLevel slog.Leveler) (*slog.Logger, *RingBuffer, func() string) {
	t.Helper()
	var stdout bytes.Buffer
	buf := NewRingBuffer(16)
	h := NewMultiHandler(
		slog.NewTextHandler(&stdout, &slog.HandlerOptions{Level: slog.LevelInfo}),
		buf, minLevel,
	)
	return slog.New(h), buf, stdout.String
}

func TestNewMultiHandler_TeesToBothSinks(t *testing.T) {
	logger, buf, stdout := newTeeLogger(t, slog.LevelDebug)

	logger.Info("hello admin")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	if entries[0].Message != "hello admin" {
		t.Errorf("Message = %q, want %q", entries[0].Message, "hello admin")
	}
	if entries[0].Level != "INFO" {
		t.Errorf("Level = %q, want INFO", entries[0].Level)
	}
	if entries[0].Timestamp == "" {
		t.Error("Timestamp is empty")
	}
	if !strings.Contains(stdout(), "hello admin") {
		t.Errorf("record did not reach stdout; got %q", stdout())
	}
}

func TestMultiHandler_Enabled(t *testing.T) {
	// stdout is at Info; the ring buffer is at Debug. Enabled is the union, so
	// a Debug record must still be handled — that is how the admin panel can
	// show debug lines the console does not.
	logger, buf, stdout := newTeeLogger(t, slog.LevelDebug)

	logger.Debug("debug only")

	if entries := buf.Snapshot(); len(entries) != 1 {
		t.Errorf("ring buffer has %d entries, want the debug record", len(entries))
	}
	if strings.Contains(stdout(), "debug only") {
		t.Error("a Debug record reached the Info-level stdout handler")
	}
}

func TestMultiHandler_RingLevelFiltersOutLowRecords(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelWarn)

	logger.Info("below the ring threshold")
	logger.Warn("at the ring threshold")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	if entries[0].Message != "at the ring threshold" {
		t.Errorf("Message = %q, want the Warn record", entries[0].Message)
	}
}

func TestMultiHandler_WithAttrs(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	logger.With("user_id", 42).Info("with attrs", "extra", "yes")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}

	var attrs map[string]any
	if err := json.Unmarshal([]byte(entries[0].Attrs), &attrs); err != nil {
		t.Fatalf("unmarshal attrs %q: %v", entries[0].Attrs, err)
	}
	// Both the WithAttrs-supplied attr and the per-record attr must survive.
	if _, ok := attrs["user_id"]; !ok {
		t.Errorf("attrs = %v, want user_id from WithAttrs", attrs)
	}
	if attrs["extra"] != "yes" {
		t.Errorf("attrs[extra] = %v, want \"yes\"", attrs["extra"])
	}
}

func TestMultiHandler_WithAttrs_DoesNotMutateParent(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	child := logger.With("scoped", "child")
	child.Info("from child")
	logger.Info("from parent")

	entries := buf.Snapshot()
	if len(entries) != 2 {
		t.Fatalf("ring buffer has %d entries, want 2", len(entries))
	}

	// withAttrs copies into a fresh slice; the parent must not inherit them.
	for _, e := range entries {
		if e.Message == "from parent" && strings.Contains(e.Attrs, "scoped") {
			t.Errorf("parent record picked up the child's attrs: %q", e.Attrs)
		}
	}
}

func TestMultiHandler_WithGroup(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	logger.WithGroup("req").Info("grouped", "id", "abc")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}

	var attrs map[string]any
	if err := json.Unmarshal([]byte(entries[0].Attrs), &attrs); err != nil {
		t.Fatalf("unmarshal attrs %q: %v", entries[0].Attrs, err)
	}
	if attrs["req.id"] != "abc" {
		t.Errorf("attrs = %v, want the group-qualified key req.id", attrs)
	}
}

func TestMultiHandler_NestedGroups(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	logger.WithGroup("outer").WithGroup("inner").Info("nested", "k", "v")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	var attrs map[string]any
	if err := json.Unmarshal([]byte(entries[0].Attrs), &attrs); err != nil {
		t.Fatalf("unmarshal attrs: %v", err)
	}
	if attrs["outer.inner.k"] != "v" {
		t.Errorf("attrs = %v, want outer.inner.k", attrs)
	}
}

func TestMultiHandler_NoAttrsLeavesAttrsEmpty(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	logger.Info("bare message")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	if entries[0].Attrs != "" {
		t.Errorf("Attrs = %q for a record with no attributes, want empty", entries[0].Attrs)
	}
}

// ─── RingBuffer.Subscribe ───────────────────────────────────────────────────

func TestRingBuffer_Subscribe_ReceivesWrites(t *testing.T) {
	buf := NewRingBuffer(8)

	ch, unsubscribe := buf.Subscribe()
	defer unsubscribe()

	buf.Write(LogEntry{Message: "first"})

	select {
	case got := <-ch:
		if got.Message != "first" {
			t.Errorf("Message = %q, want %q", got.Message, "first")
		}
	default:
		t.Fatal("subscriber received nothing")
	}
}

func TestRingBuffer_Subscribe_UnsubscribeStopsDelivery(t *testing.T) {
	buf := NewRingBuffer(8)

	ch, unsubscribe := buf.Subscribe()
	unsubscribe()

	buf.Write(LogEntry{Message: "after unsubscribe"})

	select {
	case got := <-ch:
		t.Errorf("received %q after unsubscribing", got.Message)
	default:
	}
}

func TestRingBuffer_Subscribe_MultipleSubscribersEachGetACopy(t *testing.T) {
	buf := NewRingBuffer(8)

	chA, stopA := buf.Subscribe()
	defer stopA()
	chB, stopB := buf.Subscribe()
	defer stopB()

	buf.Write(LogEntry{Message: "fanned out"})

	for i, ch := range []<-chan LogEntry{chA, chB} {
		select {
		case got := <-ch:
			if got.Message != "fanned out" {
				t.Errorf("subscriber %d got %q, want %q", i, got.Message, "fanned out")
			}
		default:
			t.Errorf("subscriber %d received nothing", i)
		}
	}
}

func TestRingBuffer_Subscribe_SlowSubscriberDoesNotBlockWrites(t *testing.T) {
	buf := NewRingBuffer(8)

	_, unsubscribe := buf.Subscribe() // never drained
	defer unsubscribe()

	// The subscriber channel holds 64; writing well past that must not block
	// the logging path — records are dropped for that subscriber instead.
	done := make(chan struct{})
	go func() {
		for i := range 200 {
			buf.Write(LogEntry{Message: "flood", Level: "INFO", Timestamp: string(rune('a' + i%26))})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-t.Context().Done():
		t.Fatal("Write blocked on a slow subscriber")
	}

	// The ring itself stays capped at its capacity.
	if got := len(buf.Snapshot()); got != 8 {
		t.Errorf("ring buffer holds %d entries, want its capacity of 8", got)
	}
}

// ─── RingBuffer ring semantics ──────────────────────────────────────────────

func TestRingBuffer_Snapshot_OldestFirstBeforeWrap(t *testing.T) {
	buf := NewRingBuffer(4)
	buf.Write(LogEntry{Message: "a"})
	buf.Write(LogEntry{Message: "b"})

	got := buf.Snapshot()
	if len(got) != 2 || got[0].Message != "a" || got[1].Message != "b" {
		t.Fatalf("Snapshot = %v, want [a b] in write order", got)
	}
}

func TestRingBuffer_Snapshot_OldestFirstAfterWrap(t *testing.T) {
	// Capacity 4, six writes: the ring keeps the newest four, oldest first.
	buf := NewRingBuffer(4)
	for _, m := range []string{"a", "b", "c", "d", "e", "f"} {
		buf.Write(LogEntry{Message: m})
	}

	got := buf.Snapshot()
	if len(got) != 4 {
		t.Fatalf("Snapshot holds %d entries, want capacity 4", len(got))
	}
	for i, want := range []string{"c", "d", "e", "f"} {
		if got[i].Message != want {
			t.Errorf("Snapshot[%d] = %q, want %q (oldest-first after wrap)", i, got[i].Message, want)
		}
	}
}

// ─── categorizeSource ───────────────────────────────────────────────────────

func TestCategorizeSource_NoPCIsServer(t *testing.T) {
	// A record built without a caller PC cannot be attributed to a package.
	if got := categorizeSource(slog.Record{}); got != "server" {
		t.Errorf("categorizeSource with PC 0 = %q, want %q", got, "server")
	}
}

func TestCategorizeSource_AttributesAdminPackage(t *testing.T) {
	logger, buf, _ := newTeeLogger(t, slog.LevelDebug)

	// This call site lives in Server/admin, so the runtime frame resolves to
	// the admin category.
	logger.Info("from the admin package")

	entries := buf.Snapshot()
	if len(entries) != 1 {
		t.Fatalf("ring buffer has %d entries, want 1", len(entries))
	}
	if entries[0].Source != "admin" {
		t.Errorf("Source = %q, want %q", entries[0].Source, "admin")
	}
}

func TestMultiHandler_HandleReturnsNil(t *testing.T) {
	var stdout bytes.Buffer
	buf := NewRingBuffer(4)
	h := NewMultiHandler(slog.NewTextHandler(&stdout, nil), buf, slog.LevelDebug)

	// Logging must never fail the caller, so Handle always reports success.
	rec := slog.Record{Level: slog.LevelInfo, Message: "direct"}
	if err := h.Handle(context.Background(), rec); err != nil {
		t.Errorf("Handle = %v, want nil", err)
	}
	if !h.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("Enabled(Info) = false")
	}
}
