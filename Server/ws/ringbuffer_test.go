package ws_test

import (
	"fmt"
	"sync"
	"testing"

	"github.com/owncord/server/ws"
)

// ─── Push ────────────────────────────────────────────────────────────────────

func TestPush_SingleEntry(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	rb.Push(1, []byte("hello"))

	// afterSeq=0 is before the oldest seq (1), so EventsSince returns nil
	// (the buffer can't confirm it covers everything the caller missed).
	// Verify via OldestSeq and a valid afterSeq instead.
	if got := rb.OldestSeq(); got != 1 {
		t.Fatalf("expected oldest seq 1, got %d", got)
	}

	// afterSeq = oldestSeq means "give me everything after seq 1" = nothing newer.
	// But we can use EventsSince with afterSeq matching oldest to get items > oldest.
	// There's only seq 1, and 1 > 1 is false, so we get 0 events.
	got := rb.EventsSince(1)
	if len(got) != 0 {
		t.Fatalf("expected 0 events when afterSeq = only seq, got %d", len(got))
	}
}

func TestPush_MultipleInOrder(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	for i := uint64(1); i <= 5; i++ {
		rb.Push(i, []byte(fmt.Sprintf("msg-%d", i)))
	}

	// Request events after the oldest (seq 1) — should return seq 2..5.
	got := rb.EventsSince(1)
	if len(got) != 4 {
		t.Fatalf("expected 4 events after seq 1, got %d", len(got))
	}
	for i, ev := range got {
		want := fmt.Sprintf("msg-%d", i+2)
		if string(ev) != want {
			t.Errorf("event[%d]: expected %q, got %q", i, want, string(ev))
		}
	}
}

func TestPush_WrapsAround(t *testing.T) {
	const cap = 4
	rb := ws.NewEventRingBuffer(cap)

	// Push 6 events into a buffer with capacity 4 — first two are evicted.
	for i := uint64(1); i <= 6; i++ {
		rb.Push(i, []byte(fmt.Sprintf("e%d", i)))
	}

	got := rb.EventsSince(0)
	// afterSeq=0 is older than oldest (seq 3), so EventsSince returns nil.
	if got != nil {
		t.Fatalf("expected nil (afterSeq too old), got %d events", len(got))
	}

	// Ask for events after seq 2 — still too old.
	got = rb.EventsSince(2)
	if got != nil {
		t.Fatalf("expected nil (afterSeq 2 still evicted), got %d events", len(got))
	}

	// Ask for events after seq 3 — should get seq 4, 5, 6.
	got = rb.EventsSince(3)
	if len(got) != 3 {
		t.Fatalf("expected 3 events after seq 3, got %d", len(got))
	}
	for i, want := range []string{"e4", "e5", "e6"} {
		if string(got[i]) != want {
			t.Errorf("event[%d]: expected %q, got %q", i, want, string(got[i]))
		}
	}
}

func TestPush_OverwritesOldest(t *testing.T) {
	const cap = 3
	rb := ws.NewEventRingBuffer(cap)

	rb.Push(1, []byte("a"))
	rb.Push(2, []byte("b"))
	rb.Push(3, []byte("c"))

	if oldest := rb.OldestSeq(); oldest != 1 {
		t.Fatalf("expected oldest seq 1, got %d", oldest)
	}

	// Overwrite seq 1.
	rb.Push(4, []byte("d"))
	if oldest := rb.OldestSeq(); oldest != 2 {
		t.Fatalf("expected oldest seq 2 after overwrite, got %d", oldest)
	}

	got := rb.EventsSince(2)
	if len(got) != 2 {
		t.Fatalf("expected 2 events, got %d", len(got))
	}
	if string(got[0]) != "c" || string(got[1]) != "d" {
		t.Errorf("expected [c, d], got [%s, %s]", got[0], got[1])
	}
}

// ─── EventsSince ─────────────────────────────────────────────────────────────

func TestEventsSince_EmptyBuffer(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	got := rb.EventsSince(0)
	if got != nil {
		t.Fatalf("expected nil for empty buffer, got %d events", len(got))
	}
}

func TestEventsSince_AfterSpecificSeq(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	for i := uint64(1); i <= 5; i++ {
		rb.Push(i, []byte(fmt.Sprintf("m%d", i)))
	}

	got := rb.EventsSince(3)
	if len(got) != 2 {
		t.Fatalf("expected 2 events after seq 3, got %d", len(got))
	}
	if string(got[0]) != "m4" || string(got[1]) != "m5" {
		t.Errorf("expected [m4, m5], got [%s, %s]", got[0], got[1])
	}
}

func TestEventsSince_TooOld(t *testing.T) {
	const cap = 4
	rb := ws.NewEventRingBuffer(cap)

	for i := uint64(1); i <= 6; i++ {
		rb.Push(i, []byte("x"))
	}

	// Oldest is seq 3. Requesting seq 1 should return nil.
	got := rb.EventsSince(1)
	if got != nil {
		t.Fatalf("expected nil for evicted seq, got %d events", len(got))
	}
}

func TestEventsSince_AtLatestSeq(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	for i := uint64(1); i <= 5; i++ {
		rb.Push(i, []byte("x"))
	}

	got := rb.EventsSince(5)
	// afterSeq equals latest — nothing newer exists.
	if len(got) != 0 {
		t.Fatalf("expected 0 events when afterSeq = latest, got %d", len(got))
	}
}

func TestEventsSince_WraparoundOrder(t *testing.T) {
	const cap = 4
	rb := ws.NewEventRingBuffer(cap)

	// Fill past capacity to force wrap.
	for i := uint64(1); i <= 7; i++ {
		rb.Push(i, []byte(fmt.Sprintf("v%d", i)))
	}

	// Oldest is seq 4. Get everything from seq 4 onward.
	got := rb.EventsSince(4)
	if len(got) != 3 {
		t.Fatalf("expected 3 events, got %d", len(got))
	}
	for i, want := range []string{"v5", "v6", "v7"} {
		if string(got[i]) != want {
			t.Errorf("event[%d]: expected %q, got %q", i, want, string(got[i]))
		}
	}
}

func TestEventsSince_AfterSeqZero_ReturnsBehavior(t *testing.T) {
	// afterSeq=0 is below the oldest seq in the buffer (seq starts at 1),
	// so EventsSince treats it as "too old" and returns nil. This is correct:
	// the server can't confirm the buffer covers everything the client missed.
	rb := ws.NewEventRingBuffer(8)
	for i := uint64(1); i <= 3; i++ {
		rb.Push(i, []byte(fmt.Sprintf("a%d", i)))
	}

	got := rb.EventsSince(0)
	if got != nil {
		t.Fatalf("expected nil for afterSeq=0 (before oldest), got %d events", len(got))
	}

	// If we start seqs from 0, then afterSeq=0 equals oldest, and we get events > 0.
	rb2 := ws.NewEventRingBuffer(8)
	rb2.Push(0, []byte("z0"))
	rb2.Push(1, []byte("z1"))
	rb2.Push(2, []byte("z2"))

	got = rb2.EventsSince(0)
	if len(got) != 2 {
		t.Fatalf("expected 2 events after seq 0, got %d", len(got))
	}
	if string(got[0]) != "z1" || string(got[1]) != "z2" {
		t.Errorf("expected [z1, z2], got [%s, %s]", got[0], got[1])
	}
}

// ─── OldestSeq ───────────────────────────────────────────────────────────────

func TestOldestSeq_Empty(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	if got := rb.OldestSeq(); got != 0 {
		t.Fatalf("expected 0 for empty buffer, got %d", got)
	}
}

func TestOldestSeq_AfterInitialPushes(t *testing.T) {
	rb := ws.NewEventRingBuffer(8)
	rb.Push(10, []byte("x"))
	rb.Push(11, []byte("y"))

	if got := rb.OldestSeq(); got != 10 {
		t.Fatalf("expected oldest seq 10, got %d", got)
	}
}

func TestOldestSeq_AfterWraparound(t *testing.T) {
	const cap = 3
	rb := ws.NewEventRingBuffer(cap)

	rb.Push(10, []byte("a"))
	rb.Push(20, []byte("b"))
	rb.Push(30, []byte("c"))
	rb.Push(40, []byte("d")) // evicts seq 10

	if got := rb.OldestSeq(); got != 20 {
		t.Fatalf("expected oldest seq 20 after wraparound, got %d", got)
	}
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

func TestConcurrent_PushAndEventsSince(t *testing.T) {
	const (
		cap     = 64
		writers = 4
		pushes  = 500
		readers = 4
		reads   = 500
	)
	rb := ws.NewEventRingBuffer(cap)

	var wg sync.WaitGroup

	// Concurrent writers.
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(base uint64) {
			defer wg.Done()
			for i := uint64(0); i < pushes; i++ {
				rb.Push(base+i, []byte("data"))
			}
		}(uint64(w) * pushes)
	}

	// Concurrent readers.
	for r := 0; r < readers; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < reads; i++ {
				_ = rb.EventsSince(0)
				_ = rb.OldestSeq()
			}
		}()
	}

	wg.Wait()

	// If we get here without a race detector complaint, the mutex is working.
	// Sanity: buffer should have events.
	if rb.OldestSeq() == 0 {
		t.Fatal("expected non-zero oldest seq after concurrent pushes")
	}
}

// ─── Table-driven: capacity boundary ─────────────────────────────────────────

func TestEventsSince_CapacityBoundaries(t *testing.T) {
	tests := []struct {
		name      string
		cap       int
		pushes    int
		afterSeq  uint64
		wantLen   int // -1 means nil
		wantFirst string
	}{
		{
			name:     "exactly at capacity, afterSeq=0 too old",
			cap:      4,
			pushes:   4,
			afterSeq: 0,
			wantLen:  -1,
		},
		{
			name:      "exactly at capacity, from oldest",
			cap:       4,
			pushes:    4,
			afterSeq:  1,
			wantLen:   3,
			wantFirst: "e2",
		},
		{
			name:     "one past capacity",
			cap:      4,
			pushes:   5,
			afterSeq: 1, // evicted
			wantLen:  -1,
		},
		{
			name:      "one past capacity, valid afterSeq",
			cap:       4,
			pushes:    5,
			afterSeq:  2,
			wantLen:   3,
			wantFirst: "e3",
		},
		{
			name:      "double capacity",
			cap:       4,
			pushes:    8,
			afterSeq:  5,
			wantLen:   3,
			wantFirst: "e6",
		},
		{
			name:     "capacity 1",
			cap:      1,
			pushes:   3,
			afterSeq: 3,
			wantLen:  0,
		},
		{
			name:     "capacity 1, afterSeq matches oldest",
			cap:      1,
			pushes:   3,
			afterSeq: 3,
			wantLen:  0,
		},
		{
			name:     "capacity 1, afterSeq too old",
			cap:      1,
			pushes:   3,
			afterSeq: 2,
			wantLen:  -1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rb := ws.NewEventRingBuffer(tc.cap)
			for i := 1; i <= tc.pushes; i++ {
				rb.Push(uint64(i), []byte(fmt.Sprintf("e%d", i)))
			}

			got := rb.EventsSince(tc.afterSeq)

			if tc.wantLen == -1 {
				if got != nil {
					t.Fatalf("expected nil, got %d events", len(got))
				}
				return
			}

			if len(got) != tc.wantLen {
				t.Fatalf("expected %d events, got %d", tc.wantLen, len(got))
			}

			if tc.wantLen > 0 && string(got[0]) != tc.wantFirst {
				t.Errorf("first event: expected %q, got %q", tc.wantFirst, string(got[0]))
			}
		})
	}
}
