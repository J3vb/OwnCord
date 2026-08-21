// Phase B Step 7 — EventPersister behavioural test.
//
// Confirms that:
//   - events flow into the configured store via the batched flusher,
//   - dropped events are counted on full queue,
//   - Stop() drains pending events before exiting.
package ws

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// captureLogs redirects the default slog logger to a buffer for the duration
// of fn and returns everything it wrote.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	return buf.String()
}

// openPersisterTestDB opens an in-memory database with migrations applied for
// EventPersister tests. *db.DB satisfies the EventStore interface the persister
// depends on (D3 removed the store abstraction).
func openPersisterTestDB(t *testing.T) *db.DB {
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

func TestEventPersisterFlushesBatch(t *testing.T) {
	mem := openPersisterTestDB(t)
	p := NewEventPersister(mem, 1024, 4, 50*time.Millisecond)
	ctx := context.Background()
	p.Start(ctx)
	t.Cleanup(func() { p.Stop(ctx) })

	for i := range 10 {
		p.Enqueue(int64(i+1), "broadcast", 0, []byte(`{"type":"x"}`))
	}

	// Wait for at least one flush tick.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		persisted, _, _, _ := p.Stats()
		if persisted >= 10 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	persisted, dropped, _, errs := p.Stats()
	if persisted != 10 {
		t.Fatalf("expected 10 persisted, got %d", persisted)
	}
	if dropped != 0 {
		t.Fatalf("expected 0 dropped, got %d", dropped)
	}
	if errs != 0 {
		t.Fatalf("expected 0 errors, got %d", errs)
	}

	// Verify the events landed in the store.
	rows, err := mem.GetEventsSince(ctx, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 10 {
		t.Fatalf("expected 10 rows in mem store, got %d", len(rows))
	}
}

func TestEventPersisterDropsOnFullQueue(t *testing.T) {
	mem := openPersisterTestDB(t)
	// Tiny queue, very long flush interval — guarantees drops because the
	// flusher won't drain fast enough.
	p := NewEventPersister(mem, 2, 1024, time.Hour)
	// NB: Start is intentionally NOT called so the queue stays full.
	for i := range 50 {
		p.Enqueue(int64(i+1), "broadcast", 0, []byte(`{}`))
	}
	// Stop without Start — must not deadlock.
	stopCtx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	p.Stop(stopCtx)
	_, dropped, _, _ := p.Stats()
	if dropped == 0 {
		t.Fatal("expected drops with full queue and no consumer")
	}
}

// slowEventStore wraps a real EventStore and adds an artificial delay to
// PersistEvents, so tests can make an in-flight flush deterministically
// outlast a short Stop context.
type slowEventStore struct {
	EventStore
	delay time.Duration
}

func (s *slowEventStore) PersistEvents(ctx context.Context, events []db.PersistedEvent) (int, error) {
	time.Sleep(s.delay)
	return s.EventStore.PersistEvents(ctx, events)
}

// TestEventPersisterStopWaitsForGoroutineExit pins the fixed contract: Stop
// must not return until the run goroutine has finished its in-flight flush,
// even when the Stop context expires first. The store flush (200ms) far
// outlasts the Stop ctx (20ms); the old select{done|ctx.Done} would have
// returned at ~20ms with nothing persisted, letting main.go's LIFO
// database.Close() run underneath a still-flushing goroutine. The fix must
// return only after the flush completes, with every event persisted.
func TestEventPersisterStopWaitsForGoroutineExit(t *testing.T) {
	mem := openPersisterTestDB(t)
	store := &slowEventStore{EventStore: mem, delay: 200 * time.Millisecond}
	// Neither the batch (1024) nor the ticker (1h) can flush before Stop is
	// called; only Stop's drain flushes, so the in-flight flush is
	// deterministic.
	p := NewEventPersister(store, 64, 1024, time.Hour)
	p.Start(context.Background())
	for i := range 5 {
		p.Enqueue(int64(i+1), "broadcast", 0, []byte(`{}`))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	start := time.Now()
	p.Stop(ctx)
	elapsed := time.Since(start)

	if elapsed < 150*time.Millisecond {
		t.Errorf("Stop returned after %v, want it to block for the ~200ms flush "+
			"(it must not abandon the goroutine when ctx expires — main.go closes "+
			"the DB right after Stop returns)", elapsed)
	}
	persisted, _, _, _ := p.Stats()
	if persisted != 5 {
		t.Errorf("persisted=%d, want 5 (Stop must wait for the in-flight flush to finish)", persisted)
	}
}

func TestEventPersisterStopDrains(t *testing.T) {
	mem := openPersisterTestDB(t)
	p := NewEventPersister(mem, 256, 100, time.Hour)
	p.Start(context.Background())

	for i := range 5 {
		p.Enqueue(int64(i+1), "broadcast", 0, []byte(`{}`))
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	p.Stop(stopCtx)

	persisted, _, _, _ := p.Stats()
	if persisted != 5 {
		t.Fatalf("expected 5 persisted after Stop drain, got %d", persisted)
	}
}

// TestEventPersisterEnqueueAfterStopDropsLoudly locks the fixed contract this
// package's own doc comment promises ("when the queue is full, events are
// dropped and a counter is incremented"): a call into Enqueue after Stop has
// fully returned must count as a drop and log loudly, not vanish silently
// into a channel nothing reads anymore. main.go's shutdown order lets exactly
// this race happen — the hub can still be broadcasting (e.g. the
// server_restart notice window) after the persister's Stop has returned, so
// callers into a stopped persister are an expected shutdown path, not a bug
// at the call site.
func TestEventPersisterEnqueueAfterStopDropsLoudly(t *testing.T) {
	mem := openPersisterTestDB(t)
	p := NewEventPersister(mem, 64, 50, time.Hour)
	p.Start(context.Background())
	p.Stop(context.Background())

	_, droppedBefore, _, _ := p.Stats()

	out := captureLogs(t, func() {
		p.Enqueue(42, "broadcast", 7, []byte(`{"type":"x"}`))
	})

	_, droppedAfter, _, _ := p.Stats()
	if droppedAfter != droppedBefore+1 {
		t.Errorf("dropped counter = %d, want %d (post-Stop Enqueue must count as a loud drop)", droppedAfter, droppedBefore+1)
	}
	for _, want := range []string{
		"event dropped",
		"seq=42",
		"channel_id=7",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("log output missing %q: %s", want, out)
		}
	}

	// The event must not have landed in the store either — a silent success
	// into a dead channel would otherwise let the row race with (or follow)
	// main.go's LIFO database.Close().
	rows, err := mem.GetEventsSince(context.Background(), 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("expected 0 rows persisted post-stop, got %d", len(rows))
	}
}
