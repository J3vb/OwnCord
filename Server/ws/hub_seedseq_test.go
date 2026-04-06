// Pass 4 — Hub.SeedSeq tests.
//
// Locks in the Pass 2 fix that aligns the in-memory monotonic counter with
// the persisted MAX(events.seq) at startup. SeedSeq must never go backwards
// even under concurrent calls and must integrate with nextSeq() so the next
// allocated seq is greater than every previously persisted row.
package ws

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestSeedSeqMonotonic(t *testing.T) {
	h := &Hub{}
	h.SeedSeq(100)
	if got := atomic.LoadUint64(&h.seq); got != 100 {
		t.Fatalf("after SeedSeq(100), seq = %d, want 100", got)
	}
	// Lower seed must be a no-op.
	h.SeedSeq(50)
	if got := atomic.LoadUint64(&h.seq); got != 100 {
		t.Fatalf("after SeedSeq(50), seq = %d, want 100 (no backwards)", got)
	}
	// Higher seed must take effect.
	h.SeedSeq(500)
	if got := atomic.LoadUint64(&h.seq); got != 500 {
		t.Fatalf("after SeedSeq(500), seq = %d, want 500", got)
	}
}

func TestSeedSeqThenNextSeq(t *testing.T) {
	h := &Hub{}
	h.SeedSeq(1000)
	got := h.nextSeq()
	if got != 1001 {
		t.Fatalf("nextSeq after SeedSeq(1000) = %d, want 1001", got)
	}
}

func TestSeedSeqConcurrent(t *testing.T) {
	h := &Hub{}
	const n = 100
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 1; i <= n; i++ {
		i := i
		go func() {
			defer wg.Done()
			h.SeedSeq(uint64(i * 7)) // distinct values, max = n*7
		}()
	}
	wg.Wait()
	want := uint64(n * 7)
	if got := atomic.LoadUint64(&h.seq); got != want {
		t.Fatalf("after concurrent seeds, seq = %d, want %d", got, want)
	}
}
