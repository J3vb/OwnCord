// Pass 4 follow-up — event pruner unit tests.
//
// Covers runPrune correctness (cutoff calculation + error path) and the
// StartEventPruner goroutine lifecycle (nil store short-circuit, ctx
// cancellation, startup-delay-bounded-by-interval behaviour introduced
// in the Copilot review fix).
package ws

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// fakeEventStore is a minimal EventStore stub that records every prune
// call and optionally returns a canned error. Only the methods actually
// exercised by the pruner are implemented; the rest panic so an accidental
// code path change is noisy.
type fakeEventStore struct {
	mu          sync.Mutex
	pruneCalls  int
	lastCutoff  time.Time
	pruneReturn int64
	pruneErr    error
	pruneSignal chan struct{} // closed (via atomic swap) once a prune happens
	pruneDone   atomic.Bool
}

func (f *fakeEventStore) PruneEventsOlderThan(_ context.Context, cutoff time.Time) (int64, error) {
	f.mu.Lock()
	f.pruneCalls++
	f.lastCutoff = cutoff
	ret := f.pruneReturn
	err := f.pruneErr
	f.mu.Unlock()
	if !f.pruneDone.Swap(true) && f.pruneSignal != nil {
		close(f.pruneSignal)
	}
	return ret, err
}

func (f *fakeEventStore) Calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pruneCalls
}

func (f *fakeEventStore) LastCutoff() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastCutoff
}

// Stubs for the rest of the EventStore interface — not exercised here.
func (*fakeEventStore) PersistEvent(context.Context, int64, string, int64, []byte) error {
	panic("unused")
}

func (*fakeEventStore) GetEventsSince(context.Context, int64, int) ([]db.PersistedEvent, error) {
	panic("unused")
}

func (*fakeEventStore) GetEventsSinceForChannels(context.Context, int64, []int64, int) ([]db.PersistedEvent, error) {
	panic("unused")
}

func (*fakeEventStore) GetMaxEventSeq(context.Context) (int64, error) {
	panic("unused")
}

func TestRunPruneCutoffCalculation(t *testing.T) {
	s := &fakeEventStore{pruneReturn: 3}
	retention := 24 * time.Hour

	before := time.Now()
	runPrune(context.Background(), s, retention)
	after := time.Now()

	if s.Calls() != 1 {
		t.Fatalf("expected 1 prune call, got %d", s.Calls())
	}
	cutoff := s.LastCutoff()
	// cutoff must be in the window [before - retention, after - retention].
	minCutoff := before.Add(-retention)
	maxCutoff := after.Add(-retention)
	if cutoff.Before(minCutoff) || cutoff.After(maxCutoff) {
		t.Errorf("cutoff %v not in expected window [%v, %v]", cutoff, minCutoff, maxCutoff)
	}
}

func TestRunPruneErrorDoesNotPanic(t *testing.T) {
	s := &fakeEventStore{pruneErr: errors.New("boom")}
	// Must not panic, must not propagate — error is logged and swallowed
	// so the background goroutine keeps ticking.
	runPrune(context.Background(), s, time.Hour)
	if s.Calls() != 1 {
		t.Fatalf("expected 1 prune call even on error, got %d", s.Calls())
	}
}

func TestStartEventPrunerNilStoreIsNoop(t *testing.T) {
	// Should not spawn a goroutine, should not panic.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	StartEventPruner(ctx, nil, time.Hour, time.Hour)
	// If the nil check were missing, calling PruneEventsOlderThan on nil
	// would panic inside the goroutine — but since we don't spawn one,
	// there's nothing to assert beyond "we got here".
}

func TestStartEventPrunerContextCancellation(t *testing.T) {
	s := &fakeEventStore{pruneSignal: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())

	// Short interval so startup delay is bounded to the interval (50ms).
	StartEventPruner(ctx, s, time.Hour, 50*time.Millisecond)

	// Wait for the first prune to happen so we know the goroutine started.
	select {
	case <-s.pruneSignal:
	case <-time.After(2 * time.Second):
		t.Fatal("pruner did not run within 2s")
	}

	// Cancel and give the goroutine a moment to exit. There's no direct
	// handle to join on, but we can verify no further prunes happen after
	// a grace period.
	cancel()
	time.Sleep(150 * time.Millisecond)
	callsAfterCancel := s.Calls()
	time.Sleep(200 * time.Millisecond)
	if s.Calls() != callsAfterCancel {
		t.Errorf("pruner kept running after ctx cancel: %d -> %d calls", callsAfterCancel, s.Calls())
	}
}

func TestStartEventPrunerStartupDelayBoundedByInterval(t *testing.T) {
	// With interval=20ms and the uncapped startup delay of 1 minute, the
	// test would have to wait a full minute for the first prune. The
	// Copilot-review fix caps the startup delay at min(interval, 1min),
	// so with interval=20ms the first prune happens within ~20ms.
	s := &fakeEventStore{pruneSignal: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	start := time.Now()
	StartEventPruner(ctx, s, time.Hour, 20*time.Millisecond)

	select {
	case <-s.pruneSignal:
		elapsed := time.Since(start)
		if elapsed > 500*time.Millisecond {
			t.Errorf("startup delay not bounded by interval: first prune took %v", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pruner did not run within 2s — startup delay likely not bounded")
	}
}
