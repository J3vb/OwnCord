package metrics

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Windows turns the cumulative figures above into "the last minute" and "the
// last fifteen minutes". A sampler ticks every WindowSpec.Tick and copies each
// source into a preallocated ring: a histogram's raw bucket counts, the
// largest value seen since the previous sample, and each counter's cumulative
// value. A window is the newest sample minus an older one. Nothing here is on
// the hot path; Observe pays only the two extra atomics in metrics.go.

// ErrBadWindowSpec is wrapped by every NewWindows validation failure.
var ErrBadWindowSpec = errors.New("metrics: invalid window spec")

// NamedHistogram binds a histogram to the name its windowed figure is reported
// under (the JSON key, so the API layer can map it without a second table).
type NamedHistogram struct {
	Name string
	H    *Histogram
}

// NamedMaxGauge binds a max gauge to its reported name.
type NamedMaxGauge struct {
	Name string
	G    *MaxGauge
}

// NamedCounter reads a cumulative, non-decreasing figure. A value that falls
// (a reset, a replaced pool) is treated as a restart from zero, never as a
// negative delta.
type NamedCounter struct {
	Name string
	Read func() uint64
}

// WindowSpec fixes what is sampled and how often. It is immutable once
// NewWindows returns: nothing registers later.
type WindowSpec struct {
	Tick, Horizon time.Duration
	Histograms    []NamedHistogram
	MaxGauges     []NamedMaxGauge
	Counters      []NamedCounter
}

// WindowSnapshot is one window's figures. Seconds is the time the window really
// covers (newest sample minus its base sample), which is shorter than the
// requested length for a young process and longer after missed ticks. AsOf is the
// newest sample's timestamp, so a reader can see how stale the figures are.
type WindowSnapshot struct {
	Seconds    float64
	AsOf       time.Time
	Histograms map[string]Summary
	MaxGauges  map[string]float64 // milliseconds
	Counters   map[string]uint64  // delta over the window
}

// slot is one sample. The slices are views into the ring's backing arrays,
// laid out in spec order.
type slot struct {
	t        time.Time
	buckets  []uint64 // len(histograms) * numBuckets
	imax     []uint64 // histograms then max gauges, microseconds
	counters []uint64
}

// Windows is the ring plus its sampler. Build it with NewWindows.
type Windows struct {
	spec WindowSpec
	now  func() time.Time

	// mu guards ring, head and length. It is a LEAF lock: the sampler reads
	// every source (atomics, and sql.DB.Stats which takes database/sql's own
	// mutex) before taking it; Snapshot does arithmetic only and is never
	// called with another lock held (only HTTP handlers call it).
	mu     syncutil.Mutex
	ring   []slot
	head   int // next slot to write
	length int // slots holding a sample, at most len(ring)

	// scratch is the sampler's read buffer. Only sample touches it, and sample
	// has one caller at a time (Run's goroutine, or a test), so it needs no lock.
	scratch slot
}

// NewWindows builds the ring for spec. now is the clock (nil means time.Now); a
// test injects its own. It rejects a non-positive Tick, a Horizon shorter than
// Tick, an empty or duplicate name, and a nil source.
func NewWindows(spec WindowSpec, now func() time.Time) (*Windows, error) {
	if spec.Tick <= 0 {
		return nil, fmt.Errorf("%w: tick %v must be positive", ErrBadWindowSpec, spec.Tick)
	}
	if spec.Horizon < spec.Tick {
		return nil, fmt.Errorf("%w: horizon %v is shorter than tick %v", ErrBadWindowSpec, spec.Horizon, spec.Tick)
	}
	seen := make(map[string]struct{})
	claim := func(name string) error {
		if name == "" {
			return fmt.Errorf("%w: empty name", ErrBadWindowSpec)
		}
		if _, dup := seen[name]; dup {
			return fmt.Errorf("%w: duplicate name %q", ErrBadWindowSpec, name)
		}
		seen[name] = struct{}{}
		return nil
	}
	for _, h := range spec.Histograms {
		if err := claim(h.Name); err != nil {
			return nil, err
		}
		if h.H == nil {
			return nil, fmt.Errorf("%w: histogram %q is nil", ErrBadWindowSpec, h.Name)
		}
	}
	for _, g := range spec.MaxGauges {
		if err := claim(g.Name); err != nil {
			return nil, err
		}
		if g.G == nil {
			return nil, fmt.Errorf("%w: max gauge %q is nil", ErrBadWindowSpec, g.Name)
		}
	}
	for _, c := range spec.Counters {
		if err := claim(c.Name); err != nil {
			return nil, err
		}
		if c.Read == nil {
			return nil, fmt.Errorf("%w: counter %q has no reader", ErrBadWindowSpec, c.Name)
		}
	}
	if now == nil {
		now = time.Now
	}

	// Own copies of the slices, so a caller cannot change the layout later.
	spec.Histograms = append([]NamedHistogram(nil), spec.Histograms...)
	spec.MaxGauges = append([]NamedMaxGauge(nil), spec.MaxGauges...)
	spec.Counters = append([]NamedCounter(nil), spec.Counters...)

	// horizon/tick samples span the horizon; two more cover the base sample
	// sitting just outside it and a tick that ran late.
	n := int(spec.Horizon/spec.Tick) + 2
	nb := len(spec.Histograms) * numBuckets
	nm := len(spec.Histograms) + len(spec.MaxGauges)
	nc := len(spec.Counters)
	allB, allM, allC := make([]uint64, n*nb), make([]uint64, n*nm), make([]uint64, n*nc)
	ring := make([]slot, n)
	for i := range ring {
		ring[i] = slot{
			buckets:  allB[i*nb : (i+1)*nb : (i+1)*nb],
			imax:     allM[i*nm : (i+1)*nm : (i+1)*nm],
			counters: allC[i*nc : (i+1)*nc : (i+1)*nc],
		}
	}
	return &Windows{
		spec: spec,
		now:  now,
		ring: ring,
		scratch: slot{
			buckets:  make([]uint64, nb),
			imax:     make([]uint64, nm),
			counters: make([]uint64, nc),
		},
	}, nil
}

// Run takes one sample at once (the baseline a window is measured from), then
// one per tick until ctx is cancelled. The returned channel closes once the
// goroutine has exited, so shutdown can order it before the hub and database
// close.
func (w *Windows) Run(ctx context.Context) <-chan struct{} {
	w.sample(w.now())
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(w.spec.Tick)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.sample(w.now())
			}
		}
	}()
	return done
}

// sample records one sample stamped now. It is the only path that takes
// samples and allocates nothing.
//
// Order matters: buckets are read first and the interval maxima swapped
// afterwards. Observe stores its max before its bucket count, so any
// observation counted here already has its max in this interval or an earlier
// one. An observation landing between the two steps has its max taken now and
// its count in the next sample, so it is counted once; at a window edge its
// count and max can show in adjacent windows.
func (w *Windows) sample(now time.Time) {
	sc := &w.scratch
	for i, nh := range w.spec.Histograms {
		nh.H.readBuckets((*[numBuckets]uint64)(sc.buckets[i*numBuckets : (i+1)*numBuckets]))
	}
	for i, nh := range w.spec.Histograms {
		sc.imax[i] = nh.H.takeIntervalMax()
	}
	for i, ng := range w.spec.MaxGauges {
		sc.imax[len(w.spec.Histograms)+i] = ng.G.takeIntervalMax()
	}
	for i, nc := range w.spec.Counters {
		sc.counters[i] = nc.Read()
	}

	w.mu.Lock()
	s := &w.ring[w.head]
	s.t = now
	copy(s.buckets, sc.buckets)
	copy(s.imax, sc.imax)
	copy(s.counters, sc.counters)
	w.head = (w.head + 1) % len(w.ring)
	if w.length < len(w.ring) {
		w.length++
	}
	w.mu.Unlock()
}

// Snapshot reports the window of length d ending at the newest sample. The base
// sample is the newest one at least d older than it, chosen by timestamp, not
// slot count, so a sampling gap widens Seconds instead of attributing a long
// stretch to a short window. When no sample is that old the oldest held is
// used. It reports false until two samples exist, and for a non-positive d.
func (w *Windows) Snapshot(d time.Duration) (WindowSnapshot, bool) {
	if d <= 0 {
		return WindowSnapshot{}, false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.length < 2 {
		return WindowSnapshot{}, false
	}
	at := func(age int) *slot { return &w.ring[(w.head-1-age+2*len(w.ring))%len(w.ring)] }
	newest := at(0)
	// Half a tick of tolerance: a real ticker stamps samples slightly off the
	// grid, so an exact "t <= newest-d" test would often miss the sample one
	// tick back and cover d plus a whole tick (70 s for "1m"). With it the base
	// is the sample nearest d back. The ring's two spare slots still hold the
	// base for the longest window.
	cutoff := newest.t.Add(-d + w.spec.Tick/2)
	baseAge := w.length - 1 // the oldest held, unless a newer one is old enough
	for age := 1; age < w.length; age++ {
		if !at(age).t.After(cutoff) {
			baseAge = age
			break
		}
	}
	base := at(baseAge)

	nh, ng := len(w.spec.Histograms), len(w.spec.MaxGauges)
	// Window max: the largest interval max among the samples in (base, newest].
	imax := make([]uint64, nh+ng)
	for age := range baseAge {
		for i, v := range at(age).imax {
			imax[i] = max(imax[i], v)
		}
	}

	out := WindowSnapshot{
		Seconds:    newest.t.Sub(base.t).Seconds(),
		AsOf:       newest.t,
		Histograms: make(map[string]Summary, nh),
		MaxGauges:  make(map[string]float64, ng),
		Counters:   make(map[string]uint64, len(w.spec.Counters)),
	}
	for i, h := range w.spec.Histograms {
		var delta [numBuckets]uint64
		var count uint64
		for b := range delta {
			// Each bucket only grows; the clamp covers a source that was reset.
			delta[b] = satSub(newest.buckets[i*numBuckets+b], base.buckets[i*numBuckets+b])
			count += delta[b]
		}
		if count == 0 {
			// A racing observation can leave its max here and its count in
			// the next sample; keep the max visible.
			out.Histograms[h.Name] = Summary{Max: float64(imax[i]) / 1000}
			continue
		}
		// The count is the sum of the bucket deltas, never the histogram's
		// total, so a torn read cannot give a count that disagrees with them.
		out.Histograms[h.Name] = Summary{
			Count: count,
			P50:   quantile(&delta, count, imax[i], 0.50),
			P95:   quantile(&delta, count, imax[i], 0.95),
			P99:   quantile(&delta, count, imax[i], 0.99),
			Max:   float64(imax[i]) / 1000,
		}
	}
	for i, g := range w.spec.MaxGauges {
		out.MaxGauges[g.Name] = float64(imax[nh+i]) / 1000
	}
	for i, c := range w.spec.Counters {
		out.Counters[c.Name] = satSub(newest.counters[i], base.counters[i])
	}
	return out, true
}

// satSub is a-b, or 0 when b is larger: a cumulative figure that went
// backwards was reset, and the window then reports no change, not a negative.
func satSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}
