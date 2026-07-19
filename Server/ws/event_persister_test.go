// Phase B Step 7 — EventPersister behavioural test.
//
// Confirms that:
//   - events flow into the configured store via the batched flusher,
//   - dropped events are counted on full queue,
//   - Stop() drains pending events before exiting.
package ws

import (
	"context"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

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

	for i := 0; i < 10; i++ {
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
	for i := 0; i < 50; i++ {
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

func TestEventPersisterStopDrains(t *testing.T) {
	mem := openPersisterTestDB(t)
	p := NewEventPersister(mem, 256, 100, time.Hour)
	p.Start(context.Background())

	for i := 0; i < 5; i++ {
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
