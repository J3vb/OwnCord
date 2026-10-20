package metrics

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

var t0 = time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)

// newTestWindows builds a 10 s / 15 min ring over one histogram, one max gauge
// and one counter, sampled by direct sample(now) calls so no test sleeps.
func newTestWindows(t *testing.T) (*Windows, *Histogram, *MaxGauge, *atomic.Uint64) {
	t.Helper()
	var h Histogram
	var g MaxGauge
	var c atomic.Uint64
	w, err := NewWindows(WindowSpec{
		Tick:       10 * time.Second,
		Horizon:    15 * time.Minute,
		Histograms: []NamedHistogram{{"lat", &h}},
		MaxGauges:  []NamedMaxGauge{{"hold", &g}},
		Counters:   []NamedCounter{{"drops", c.Load}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return w, &h, &g, &c
}

func snap(t *testing.T, w *Windows, d time.Duration) WindowSnapshot {
	t.Helper()
	s, ok := w.Snapshot(d)
	if !ok {
		t.Fatalf("Snapshot(%v) not ready", d)
	}
	return s
}

// TestWindows_StallRaisesAndRecovers is the ARCH-028 acceptance: a stall shows
// in the 1m figures, ages out of them, stays in 15m, and the lifetime figures
// never fall.
func TestWindows_StallRaisesAndRecovers(t *testing.T) {
	w, h, g, c := newTestWindows(t)
	now := t0
	w.sample(now) // baseline
	tick := func(observe func()) {
		observe()
		now = now.Add(10 * time.Second)
		w.sample(now)
	}
	for range 6 { // a quiet minute
		tick(func() {
			for range 20 {
				h.Observe(1)
			}
		})
	}
	for range 3 { // 30 s stall
		tick(func() {
			for range 20 {
				h.Observe(500)
			}
			g.Observe(480)
			c.Add(5)
		})
	}
	s1 := snap(t, w, time.Minute)
	if s1.Histograms["lat"].P95 != 500 || s1.Histograms["lat"].Max != 500 {
		t.Fatalf("1m during stall = %+v, want p95/max 500", s1.Histograms["lat"])
	}
	if s1.MaxGauges["hold"] != 480 || s1.Counters["drops"] != 15 {
		t.Fatalf("1m hold/drops = %v/%v, want 480/15", s1.MaxGauges["hold"], s1.Counters["drops"])
	}

	for range 8 { // 80 s of fast traffic
		tick(func() {
			for range 20 {
				h.Observe(1)
			}
		})
	}
	s1 = snap(t, w, time.Minute)
	if s1.Histograms["lat"].P95 != 1 || s1.Histograms["lat"].Max != 1 {
		t.Fatalf("1m after recovery = %+v, want p95/max 1", s1.Histograms["lat"])
	}
	if s1.MaxGauges["hold"] != 0 || s1.Counters["drops"] != 0 {
		t.Fatalf("1m hold/drops after recovery = %v/%v, want 0/0", s1.MaxGauges["hold"], s1.Counters["drops"])
	}
	s15 := snap(t, w, 15*time.Minute)
	if s15.Histograms["lat"].Max != 500 || s15.MaxGauges["hold"] != 480 || s15.Counters["drops"] != 15 {
		t.Fatalf("15m = %+v, want the stall still visible", s15)
	}
	if got := h.Snapshot().Max; got != 500 {
		t.Fatalf("lifetime max = %v, want 500", got)
	}
	if !s1.AsOf.Equal(now) {
		t.Fatalf("as_of = %v, want newest sample %v", s1.AsOf, now)
	}
}

// Edge 1: a young process reports what exists, and nothing before two samples.
func TestWindows_YoungProcessCoversWhatExists(t *testing.T) {
	w, h, _, _ := newTestWindows(t)
	if _, ok := w.Snapshot(time.Minute); ok {
		t.Fatal("Snapshot ready with no samples")
	}
	w.sample(t0)
	if _, ok := w.Snapshot(time.Minute); ok {
		t.Fatal("Snapshot ready with one sample")
	}
	h.Observe(3)
	w.sample(t0.Add(40 * time.Second))
	s := snap(t, w, time.Minute)
	if s.Seconds != 40 {
		t.Fatalf("seconds = %v, want 40 (what exists)", s.Seconds)
	}
	if s.Histograms["lat"].Count != 1 {
		t.Fatalf("count = %d, want 1", s.Histograms["lat"].Count)
	}
	if _, ok := w.Snapshot(0); ok {
		t.Fatal("a non-positive window must not be ready")
	}
}

// Edge 1, suspend: the base is chosen by time, so a gap widens seconds.
func TestWindows_GapUsesTimeNotSlots(t *testing.T) {
	w, h, _, _ := newTestWindows(t)
	w.sample(t0)
	h.Observe(2)
	w.sample(t0.Add(10 * time.Second))
	// The host sleeps for 20 minutes; the next tick lands afterwards.
	h.Observe(2)
	w.sample(t0.Add(20*time.Minute + 10*time.Second))
	s := snap(t, w, time.Minute)
	// Newest minus 60 s is t0+19m10s: the newest sample at or before it is t0+10s.
	if s.Seconds != 20*60 {
		t.Fatalf("seconds = %v, want 1200 (honest about the gap)", s.Seconds)
	}
	if s.Histograms["lat"].Count != 1 {
		t.Fatalf("count = %d, want 1 (only the post-gap observation)", s.Histograms["lat"].Count)
	}
}

// Edge 2: a source that resets never produces a negative delta.
func TestWindows_ResetNeverNegative(t *testing.T) {
	w, _, _, c := newTestWindows(t)
	c.Store(100)
	w.sample(t0)
	c.Store(3) // a restart or replaced pool
	w.sample(t0.Add(10 * time.Second))
	if got := snap(t, w, time.Minute).Counters["drops"]; got != 0 {
		t.Fatalf("delta across a reset = %d, want 0", got)
	}
}

// Edge 2: observations racing the sampler are all counted, once, and never
// produce a negative or surplus figure.
func TestWindows_ConcurrentObserveNeverNegativeOrLost(t *testing.T) {
	w, h, _, _ := newTestWindows(t)
	now := t0
	w.sample(now)
	const workers, per = 8, 5000
	var wg sync.WaitGroup
	stop := make(chan struct{})
	sampled := make(chan struct{})
	go func() { // the sampler, bounded so the 92-slot ring never wraps
		defer close(sampled)
		for range 80 {
			select {
			case <-stop:
				return
			default:
				now = now.Add(10 * time.Second)
				w.sample(now)
				runtime.Gosched()
			}
		}
	}()
	for range workers {
		wg.Go(func() {
			for i := range per {
				h.Observe(float64(i % 400))
			}
		})
	}
	wg.Wait()
	close(stop)
	<-sampled
	now = now.Add(10 * time.Second)
	w.sample(now)

	s := snap(t, w, 15*time.Minute)
	if got := s.Histograms["lat"].Count; got != workers*per {
		t.Fatalf("window count = %d, want %d", got, workers*per)
	}
	if s.Histograms["lat"].Max != 399 {
		t.Fatalf("window max = %v, want 399", s.Histograms["lat"].Max)
	}
}

func TestWindows_RingIsBounded(t *testing.T) {
	w, _, _, _ := newTestWindows(t)
	if len(w.ring) != 92 {
		t.Fatalf("ring = %d slots, want 92", len(w.ring))
	}
	now := t0
	for range 2 * 90 {
		now = now.Add(10 * time.Second)
		w.sample(now)
	}
	if w.length != len(w.ring) || len(w.ring) != 92 {
		t.Fatalf("length/cap = %d/%d, want 92/92", w.length, len(w.ring))
	}
	s := snap(t, w, 15*time.Minute)
	if s.Seconds != 900 {
		t.Fatalf("seconds on a full ring = %v, want 900", s.Seconds)
	}
}

func TestNewWindows_RejectsBadSpec(t *testing.T) {
	var h Histogram
	var g MaxGauge
	ok := func() WindowSpec {
		return WindowSpec{Tick: time.Second, Horizon: time.Minute,
			Histograms: []NamedHistogram{{"a", &h}}, MaxGauges: []NamedMaxGauge{{"b", &g}},
			Counters: []NamedCounter{{"c", func() uint64 { return 0 }}}}
	}
	if _, err := NewWindows(ok(), nil); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	cases := map[string]func(*WindowSpec){
		"zero tick":      func(s *WindowSpec) { s.Tick = 0 },
		"horizon<tick":   func(s *WindowSpec) { s.Horizon = time.Millisecond },
		"duplicate":      func(s *WindowSpec) { s.Counters[0].Name = "a" },
		"empty name":     func(s *WindowSpec) { s.MaxGauges[0].Name = "" },
		"nil histogram":  func(s *WindowSpec) { s.Histograms[0].H = nil },
		"nil max gauge":  func(s *WindowSpec) { s.MaxGauges[0].G = nil },
		"nil counter fn": func(s *WindowSpec) { s.Counters[0].Read = nil },
	}
	for name, mutate := range cases {
		spec := ok()
		mutate(&spec)
		if _, err := NewWindows(spec, nil); !errors.Is(err, ErrBadWindowSpec) {
			t.Errorf("%s: err = %v, want ErrBadWindowSpec", name, err)
		}
	}
}

func TestWindows_RunExitsOnCancel(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		w, h, _, _ := newTestWindows(t)
		ctx, cancel := context.WithCancel(context.Background())
		done := w.Run(ctx)
		if w.length != 1 {
			t.Fatalf("Run took %d samples at start, want the baseline", w.length)
		}
		h.Observe(1)
		time.Sleep(25 * time.Second) // two ticks on the fake clock
		synctest.Wait()
		if got := snap(t, w, time.Minute).Histograms["lat"].Count; got != 1 {
			t.Fatalf("count after ticks = %d, want 1", got)
		}
		cancel()
		<-done
	})
}

// A real ticker stamps samples a little off the grid. The base sample is the
// one nearest the window length back, so "1m" covers 60 s, not 70 s, whichever
// side of the grid the jitter falls.
func TestWindows_JitteredStampsStillCoverTheNominalWindow(t *testing.T) {
	tick := 10 * time.Second
	jitter := 4 * time.Millisecond
	run := func(t *testing.T, jit func(i, last int) time.Duration) {
		w, h, _, _ := newTestWindows(t)
		const last = 100 // more than the 15m horizon: the ring has wrapped
		for i := 0; i <= last; i++ {
			h.Observe(1)
			w.sample(t0.Add(time.Duration(i)*tick + jit(i, last)))
		}
		for _, c := range []struct {
			d    time.Duration
			want float64
		}{{time.Minute, 60}, {15 * time.Minute, 900}} {
			if got := snap(t, w, c.d).Seconds; got != c.want && (got < c.want-0.01 || got > c.want+0.01) {
				t.Errorf("%v window covers %v s, want %v (within jitter)", c.d, got, c.want)
			}
		}
	}
	t.Run("old sample late", func(t *testing.T) {
		// Every sample a few ms late except the newest: the grid sample one
		// minute back is later than newest-60s by the jitter.
		run(t, func(i, last int) time.Duration {
			if i == last {
				return 0
			}
			return jitter
		})
	})
	t.Run("newest sample late", func(t *testing.T) {
		run(t, func(i, last int) time.Duration {
			if i == last {
				return jitter
			}
			return 0
		})
	})
}
