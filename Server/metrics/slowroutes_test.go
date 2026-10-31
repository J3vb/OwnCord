package metrics

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock is a settable clock safe to read from many goroutines.
type fakeClock struct{ unix atomic.Int64 }

func (c *fakeClock) now() time.Time      { return time.Unix(c.unix.Load(), 0) }
func (c *fakeClock) add(d time.Duration) { c.unix.Add(int64(d / time.Second)) }

func newFakeClock() *fakeClock {
	c := &fakeClock{}
	c.unix.Store(1_793_386_200) // on a slot boundary
	return c
}

// Requests to one pattern are one row whatever their ids; the row carries the
// count, a coarse typical time and the exact worst.
func TestSlowRoutes_GroupsByPattern(t *testing.T) {
	clk := newFakeClock()
	s := NewSlowRoutes(clk.now)
	for range 19 {
		s.Observe("GET", "/api/v1/channels/{id}/messages", 8*time.Millisecond)
	}
	s.Observe("GET", "/api/v1/channels/{id}/messages", 730*time.Millisecond)
	s.Observe("POST", "/api/v1/channels/{id}/messages", 3*time.Millisecond)
	s.Observe("GET", "", time.Second) // no route matched

	got := s.Slowest(10)
	if len(got) != 2 {
		t.Fatalf("got %d rows, want 2: %+v", len(got), got)
	}
	want := RouteTiming{Method: "GET", Route: "/api/v1/channels/{id}/messages", Count: 20, P50: 10, P95: 10, Max: 730}
	if got[0] != want {
		t.Errorf("row 0 = %+v, want %+v", got[0], want)
	}
	if got[1].Method != "POST" || got[1].Count != 1 || got[1].Max != 3 {
		t.Errorf("row 1 = %+v, want the one POST", got[1])
	}
}

// Rows sort by 95th percentile, then worst time, and n caps the list.
func TestSlowRoutes_SlowestFirstAndCapped(t *testing.T) {
	s := NewSlowRoutes(newFakeClock().now)
	for i := range 15 {
		s.Observe("GET", fmt.Sprintf("/r%02d", i), time.Duration(i+1)*15*time.Millisecond)
	}
	got := s.Slowest(10)
	if len(got) != 10 {
		t.Fatalf("got %d rows, want 10", len(got))
	}
	if got[0].Route != "/r14" {
		t.Errorf("first = %s, want /r14 (the slowest)", got[0].Route)
	}
	for i := 1; i < len(got); i++ {
		a, b := got[i-1], got[i]
		if a.P95 < b.P95 || (a.P95 == b.P95 && a.Max < b.Max) {
			t.Errorf("rows %d and %d out of order: %+v then %+v", i-1, i, a, b)
		}
	}
	if s.Slowest(0) == nil || len(s.Slowest(0)) != 0 {
		t.Error("Slowest(0) must be an empty, non-nil list")
	}
	var none *SlowRoutes
	none.Observe("GET", "/x", time.Second)
	if got := none.Slowest(10); got == nil || len(got) != 0 {
		t.Errorf("nil tracker = %v, want an empty list", got)
	}
}

// A request leaves the window an hour after its slot started, and a slot the
// ring wraps back onto starts clean.
func TestSlowRoutes_HourWindow(t *testing.T) {
	clk := newFakeClock()
	s := NewSlowRoutes(clk.now)
	s.Observe("GET", "/old", 900*time.Millisecond)
	clk.add(55 * time.Minute)
	s.Observe("GET", "/new", 40*time.Millisecond)
	if got := s.Slowest(10); len(got) != 2 {
		t.Fatalf("at 55 min got %d rows, want both", len(got))
	}
	clk.add(5 * time.Minute) // /old's slot is now twelve slots back
	got := s.Slowest(10)
	if len(got) != 1 || got[0].Route != "/new" {
		t.Fatalf("at 60 min got %+v, want only /new", got)
	}
	s.Observe("GET", "/old", 2*time.Millisecond) // lands on /old's reused slot
	for _, r := range s.Slowest(10) {
		if r.Route == "/old" && (r.Count != 1 || r.Max != 2) {
			t.Errorf("/old = %+v, want only the new 2 ms call", r)
		}
	}
}

// A route set past maxSlowRoutes is dropped rather than growing without bound.
func TestSlowRoutes_BoundedRoutes(t *testing.T) {
	s := NewSlowRoutes(newFakeClock().now)
	for i := range maxSlowRoutes + 50 {
		s.Observe("GET", fmt.Sprintf("/r%d", i), time.Millisecond)
	}
	if got := len(s.Slowest(maxSlowRoutes * 2)); got != maxSlowRoutes {
		t.Errorf("tracked %d routes, want %d", got, maxSlowRoutes)
	}
}

// Many writers and readers across slot rollovers: under -race nothing races,
// and every row a reader sees is one consistent copy (its count is never
// below what its buckets imply, its max is never above the slowest call).
func TestSlowRoutes_ConcurrentAcrossRollover(t *testing.T) {
	clk := newFakeClock()
	s := NewSlowRoutes(clk.now)
	const writers, perWriter = 16, 2000
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for w := range writers {
		wg.Go(func() {
			for i := range perWriter {
				s.Observe("GET", fmt.Sprintf("/r%d", (w+i)%8), time.Duration(i%50)*time.Millisecond)
			}
		})
	}
	var readerWG sync.WaitGroup
	readerWG.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, r := range s.Slowest(10) {
				if r.Count == 0 || r.Max > 49 || r.P50 > r.Max || r.P95 > r.Max {
					t.Errorf("inconsistent row %+v", r)
					return
				}
			}
		}
	})
	readerWG.Go(func() {
		for range 6 {
			select {
			case <-stop:
				return
			case <-time.After(time.Millisecond):
				clk.add(SlowRouteSlot)
			}
		}
	})
	wg.Wait()
	close(stop)
	readerWG.Wait()
}
