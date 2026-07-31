package db_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// fakeAuditStore records the batches handed to PersistAudits so tests can
// assert on batching behavior without a real database.
type fakeAuditStore struct {
	mu      sync.Mutex
	batches [][]db.AuditEntry
	entries []db.AuditEntry
	err     error // when non-nil, PersistAudits persists nothing
}

func (f *fakeAuditStore) PersistAudits(_ context.Context, entries []db.AuditEntry) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return 0, f.err
	}
	cp := append([]db.AuditEntry(nil), entries...)
	f.batches = append(f.batches, cp)
	f.entries = append(f.entries, cp...)
	return len(entries), nil
}

func (f *fakeAuditStore) snapshot() (batches int, entries []db.AuditEntry) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.batches), append([]db.AuditEntry(nil), f.entries...)
}

// waitForPersisted polls the writer's Stats until the persisted counter
// reaches want or the deadline passes.
func waitForPersisted(t *testing.T, w *db.AuditWriter, want uint64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if persisted, _, _, _ := w.Stats(); persisted >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	persisted, dropped, flushes, errs := w.Stats()
	t.Fatalf("timed out waiting for persisted=%d; stats: persisted=%d dropped=%d flushes=%d errors=%d",
		want, persisted, dropped, flushes, errs)
}

func TestAuditWriter_BatchFlush(t *testing.T) {
	store := &fakeAuditStore{}
	// flushEvery is huge so the only flush trigger is the batch filling up —
	// this pins that a full batch goes to the store as one PersistAudits call.
	w := db.NewAuditWriter(store, 16, 4, time.Hour)
	defer w.Stop(context.Background())

	// Enqueue before Start so the run loop sees all four immediately.
	for i := int64(1); i <= 4; i++ {
		w.Enqueue(i, fmt.Sprintf("action_%d", i), "user", i*10, fmt.Sprintf("detail_%d", i))
	}
	w.Start(context.Background())
	waitForPersisted(t, w, 4)

	batches, entries := store.snapshot()
	if batches != 1 {
		t.Errorf("store received %d batches, want 1 (batch-size flush)", batches)
	}
	if len(entries) != 4 {
		t.Fatalf("store received %d entries, want 4", len(entries))
	}
	// Field mapping and order must survive the queue round-trip.
	for i, e := range entries {
		n := int64(i + 1)
		if e.ActorID != n || e.Action != fmt.Sprintf("action_%d", n) ||
			e.TargetType != "user" || e.TargetID != n*10 || e.Detail != fmt.Sprintf("detail_%d", n) {
			t.Errorf("entry %d = %+v, want actor=%d action=action_%d target=user/%d detail=detail_%d",
				i, e, n, n, n*10, n)
		}
	}
}

func TestAuditWriter_DropOnFullQueueLogsError(t *testing.T) {
	store := &fakeAuditStore{}
	// Queue of one, not yet started: the second enqueue must drop.
	w := db.NewAuditWriter(store, 1, 50, time.Hour)

	out := captureLogs(t, func() {
		w.Enqueue(1, "kept_action", "user", 1, "kept detail")
		w.Enqueue(7, "dropped_action", "user", 42, "secret detail")
	})

	if _, dropped, _, _ := w.Stats(); dropped != 1 {
		t.Errorf("dropped counter = %d, want 1", dropped)
	}
	// D8: the drop must not be silent and must identify what was lost.
	for _, want := range []string{
		"audit log dropped",
		"action=dropped_action",
		"actor_id=7",
		"target_type=user",
		"target_id=42",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("drop log missing %q; got: %s", want, out)
		}
	}
	// The detail string must not leak into logs.
	if strings.Contains(out, "secret detail") {
		t.Errorf("detail string leaked into drop log: %s", out)
	}

	// The queued entry must still land once the writer runs.
	w.Start(context.Background())
	w.Stop(context.Background())
	if persisted, _, _, _ := w.Stats(); persisted != 1 {
		t.Errorf("persisted = %d, want 1 (the non-dropped entry)", persisted)
	}
}

func TestAuditWriter_DrainOnStop(t *testing.T) {
	store := &fakeAuditStore{}
	// Neither flush trigger can fire (batch 50, ticker 1h): everything must
	// be flushed by Stop's drain.
	w := db.NewAuditWriter(store, 64, 50, time.Hour)
	w.Start(context.Background())
	for i := range int64(10) {
		w.Enqueue(i, "drain_action", "user", i, "")
	}
	w.Stop(context.Background())

	persisted, dropped, _, _ := w.Stats()
	if persisted != 10 || dropped != 0 {
		t.Errorf("persisted=%d dropped=%d, want 10/0", persisted, dropped)
	}
	if _, entries := store.snapshot(); len(entries) != 10 {
		t.Errorf("store received %d entries after Stop, want 10", len(entries))
	}
}

// slowAuditStore models a store whose flushes take a while (a slow/stalled
// disk). It tracks whether any flush ran after Close was called — mirroring
// main.go closing the database right after AuditWriter.Stop returns.
type slowAuditStore struct {
	mu           sync.Mutex
	delay        time.Duration
	closed       bool
	persisted    int
	flushAfter   int // entries flushed after Close (a correctness violation)
	flushesAfter int
}

func (s *slowAuditStore) PersistAudits(_ context.Context, entries []db.AuditEntry) (int, error) {
	s.mu.Lock()
	closedAtEntry := s.closed
	delay := s.delay
	s.mu.Unlock()

	if delay > 0 {
		time.Sleep(delay)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if closedAtEntry || s.closed {
		s.flushesAfter++
		s.flushAfter += len(entries)
	}
	s.persisted += len(entries)
	return len(entries), nil
}

func (s *slowAuditStore) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
}

func (s *slowAuditStore) stats() (persisted, flushAfter, flushesAfter int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persisted, s.flushAfter, s.flushesAfter
}

// TestAuditWriter_StopWaitsForGoroutineExit pins the fixed contract: Stop must
// not return until the run goroutine has finished its in-flight flush, even
// when the Stop context expires first. The store flush (200ms) far outlasts
// the Stop ctx (20ms); the old select{done|ctx.Done} would have returned at
// ~20ms with nothing persisted. The fix must return only after the flush
// completes, with every entry persisted.
func TestAuditWriter_StopWaitsForGoroutineExit(t *testing.T) {
	store := &slowAuditStore{delay: 200 * time.Millisecond}
	// Neither the batch (50) nor the ticker (1h) can flush; only Stop's drain
	// flushes, so the in-flight flush is deterministic.
	w := db.NewAuditWriter(store, 64, 50, time.Hour)
	w.Start(context.Background())
	for i := range int64(5) {
		w.Enqueue(i, "slow_action", "user", i, "")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	start := time.Now()
	w.Stop(ctx)
	elapsed := time.Since(start)

	if elapsed < 150*time.Millisecond {
		t.Errorf("Stop returned after %v, want it to block for the ~200ms flush "+
			"(it must not abandon the goroutine when ctx expires)", elapsed)
	}
	persisted, flushAfter, _ := store.stats()
	if persisted != 5 {
		t.Errorf("persisted=%d, want 5 (Stop must wait for the flush to finish)", persisted)
	}
	if flushAfter != 0 {
		t.Errorf("flushAfter=%d, want 0 (nothing was closed yet)", flushAfter)
	}
	if p, _, _, _ := w.Stats(); p != 5 {
		t.Errorf("writer persisted counter = %d, want 5", p)
	}
}

// TestAuditWriter_StopDrainsBeforeStoreClose reproduces main.go's LIFO
// shutdown ordering (AuditWriter.Stop, then database.Close) and asserts the
// fix: because Stop returns only after the goroutine exits, no flush can run
// after the store is closed — so a slow-disk shutdown never writes into a
// closed pool (the D8 audit-loss race).
func TestAuditWriter_StopDrainsBeforeStoreClose(t *testing.T) {
	store := &slowAuditStore{delay: 200 * time.Millisecond}
	w := db.NewAuditWriter(store, 64, 50, time.Hour)
	w.Start(context.Background())
	for i := range int64(5) {
		w.Enqueue(i, "shutdown_action", "user", i, "")
	}

	// Stop ctx expires long before the flush finishes, as in a >5s disk stall.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	w.Stop(ctx)

	// Mirror main.go: close the store immediately after Stop returns.
	store.close()

	persisted, flushAfter, flushesAfter := store.stats()
	if flushAfter != 0 || flushesAfter != 0 {
		t.Errorf("%d entries across %d flushes ran after store close; want 0 "+
			"(Stop must fully drain before the DB is closed)", flushAfter, flushesAfter)
	}
	if persisted != 5 {
		t.Errorf("persisted=%d, want 5 before store close", persisted)
	}
}

func TestAuditWriter_FlushFailureCountsAndLogs(t *testing.T) {
	store := &fakeAuditStore{err: errors.New("disk on fire")}
	w := db.NewAuditWriter(store, 16, 50, time.Hour)

	out := captureLogs(t, func() {
		w.Start(context.Background())
		w.Enqueue(1, "lost_action", "user", 1, "")
		w.Enqueue(2, "lost_action", "user", 2, "")
		w.Stop(context.Background())
	})

	if _, _, _, errs := w.Stats(); errs != 2 {
		t.Errorf("errors counter = %d, want 2", errs)
	}
	for _, want := range []string{"flush lost audit entries", "disk on fire"} {
		if !strings.Contains(out, want) {
			t.Errorf("flush-failure log missing %q; got: %s", want, out)
		}
	}
}

func TestAuditWriter_NilReceiverIsSafe(t *testing.T) {
	var w *db.AuditWriter
	w.Enqueue(1, "a", "user", 1, "") // must not panic
	w.Stop(context.Background())     // must not panic
}

func TestNewAuditWriter_PanicsOnNilStore(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewAuditWriter(nil, ...) did not panic")
		}
	}()
	db.NewAuditWriter(nil, 0, 0, 0)
}

func TestAuditWriter_ConcurrentEnqueue(t *testing.T) {
	store := &fakeAuditStore{}
	w := db.NewAuditWriter(store, 4096, 32, time.Millisecond)
	w.Start(context.Background())

	const goroutines, perGoroutine = 8, 250
	var wg sync.WaitGroup
	for g := range goroutines {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := range perGoroutine {
				w.Enqueue(int64(g), "concurrent_action", "user", int64(i), "")
			}
		}(g)
	}
	wg.Wait()
	w.Stop(context.Background())

	persisted, dropped, _, _ := w.Stats()
	if persisted+dropped != goroutines*perGoroutine {
		t.Errorf("persisted(%d)+dropped(%d) = %d, want %d",
			persisted, dropped, persisted+dropped, goroutines*perGoroutine)
	}
	if _, entries := store.snapshot(); uint64(len(entries)) != persisted {
		t.Errorf("store received %d entries, want %d (persisted counter)", len(entries), persisted)
	}
}

// ─── PersistAudits (batch insert + per-row fallback) ─────────────────────────

func TestPersistAudits_SingleTransaction(t *testing.T) {
	database := newAdminTestDB(t)
	uid := seedUser(t, database, "batchactor")

	entries := []db.AuditEntry{
		{ActorID: uid, Action: "first", TargetType: "user", TargetID: 1, Detail: "d1"},
		{ActorID: uid, Action: "second", TargetType: "channel", TargetID: 2, Detail: "d2"},
		{ActorID: uid, Action: "third", TargetType: "server", TargetID: 0, Detail: ""},
	}
	persisted, err := database.PersistAudits(context.Background(), entries)
	if err != nil {
		t.Fatalf("PersistAudits() error: %v", err)
	}
	if persisted != 3 {
		t.Fatalf("PersistAudits() = %d, want 3", persisted)
	}

	got, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("GetAuditLog() = %d entries, want 3", len(got))
	}
	// Newest-first: the last inserted row comes back first.
	if got[0].Action != "third" || got[2].Action != "first" {
		t.Errorf("unexpected order: got[0]=%q got[2]=%q, want third/first", got[0].Action, got[2].Action)
	}
	if got[1].Detail != "d2" || got[1].TargetType != "channel" || got[1].TargetID != 2 {
		t.Errorf("middle entry = %+v, want action=second target=channel/2 detail=d2", got[1])
	}
}

func TestPersistAudits_PoisonRowFallsBackPerRow(t *testing.T) {
	database := newAdminTestDB(t)
	uid := seedUser(t, database, "poisonactor")

	// The admin test schema declares actor_id REFERENCES users(id) and Open
	// enables foreign_keys, so a nonexistent actor poisons the transaction.
	entries := []db.AuditEntry{
		{ActorID: uid, Action: "good_one", TargetType: "user", TargetID: 1},
		{ActorID: 999999, Action: "poison", TargetType: "user", TargetID: 2},
		{ActorID: uid, Action: "good_two", TargetType: "user", TargetID: 3},
	}
	persisted, err := database.PersistAudits(context.Background(), entries)
	if err == nil {
		t.Error("PersistAudits() error = nil, want the poison row's error")
	}
	if persisted != 2 {
		t.Fatalf("PersistAudits() = %d, want 2 (good rows land despite poison row)", persisted)
	}

	got, dbErr := database.GetAuditLog(context.Background(), 10, 0)
	if dbErr != nil {
		t.Fatalf("GetAuditLog() error: %v", dbErr)
	}
	if len(got) != 2 {
		t.Fatalf("GetAuditLog() = %d entries, want 2", len(got))
	}
	if got[0].Action != "good_two" || got[1].Action != "good_one" {
		t.Errorf("surviving actions = %q, %q; want good_two, good_one", got[0].Action, got[1].Action)
	}
}

func TestPersistAudits_EmptyBatch(t *testing.T) {
	database := newAdminTestDB(t)
	persisted, err := database.PersistAudits(context.Background(), nil)
	if err != nil || persisted != 0 {
		t.Errorf("PersistAudits(nil) = (%d, %v), want (0, nil)", persisted, err)
	}
}

// ─── WriteAudit routing (sync fallback vs installed writer) ──────────────────

// TestWriteAudit_SynchronousWithoutWriter pins the token CLI contract: a bare
// *DB with no writer installed writes audit entries synchronously, so the
// entry is visible the moment WriteAudit returns.
func TestWriteAudit_SynchronousWithoutWriter(t *testing.T) {
	database := newAdminTestDB(t)
	uid := seedUser(t, database, "syncactor")

	db.WriteAudit(context.Background(), database, uid, "cli_action", "api_token", 5, "label")

	got, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(got) != 1 || got[0].Action != "cli_action" {
		t.Fatalf("GetAuditLog() = %+v, want exactly the synchronously written cli_action", got)
	}
}

// TestWriteAudit_AsyncWithInstalledWriter verifies the seam: once main.go
// installs a writer on the *DB, WriteAudit enqueues instead of inserting —
// the row only lands when the writer flushes (here forced via Stop's drain).
func TestWriteAudit_AsyncWithInstalledWriter(t *testing.T) {
	database := newAdminTestDB(t)
	uid := seedUser(t, database, "asyncactor")

	// Neither flush trigger can fire before Stop, making "not yet written"
	// deterministic rather than a timing accident.
	w := db.NewAuditWriter(database, 16, 50, time.Hour)
	w.Start(context.Background())
	database.SetAuditWriter(w)

	db.WriteAudit(context.Background(), database, uid, "async_action", "user", uid, "detail")

	got, err := database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("entry visible before flush: %+v — WriteAudit did not take the async path", got)
	}

	w.Stop(context.Background())
	got, err = database.GetAuditLog(context.Background(), 10, 0)
	if err != nil {
		t.Fatalf("GetAuditLog() after Stop error: %v", err)
	}
	if len(got) != 1 || got[0].Action != "async_action" || got[0].Detail != "detail" {
		t.Fatalf("GetAuditLog() after Stop = %+v, want the drained async_action entry", got)
	}
}
