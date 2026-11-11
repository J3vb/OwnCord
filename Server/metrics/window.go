package metrics

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Windows turns the cumulative figures into "the last minute" and "the last
// fifteen minutes": a sampler copies each source (histogram bucket counts, the
// max since the previous sample, counter values) into a preallocated ring every
// WindowSpec.Tick, and a window is the newest sample minus an older one. Nothing
// here is on the hot path.

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

// NamedCounter reads a cumulative, non-decreasing figure; a fall (reset,
// replaced pool) is treated as a restart from zero, never a negative delta.
type NamedCounter struct {
	Name string
	Read func() uint64
}

// WindowSpec fixes what is sampled and how often; immutable once NewWindows returns.
type WindowSpec struct {
	Tick, Horizon time.Duration
	Histograms    []NamedHistogram
	MaxGauges     []NamedMaxGauge
	Counters      []NamedCounter
}

// WindowSnapshot is one window's figures. Seconds is the time actually covered:
// shorter than requested for a young process, longer after missed ticks. AsOf
// is the newest sample's timestamp, showing staleness.
type WindowSnapshot struct {
	Seconds    float64
	AsOf       time.Time
	Histograms map[string]Summary
	MaxGauges  map[string]float64 // milliseconds
	Counters   map[string]uint64  // delta over the window
}

// slot is one sample; the slices are views into the ring's backing arrays in spec order.
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

	// mu guards ring, head and length. LEAF lock: the sampler reads every source
	// (including sql.DB.Stats, which takes database/sql's mutex) before taking it,
	// and Snapshot (HTTP handlers only) does arithmetic only.
	mu     syncutil.Mutex
	ring   []slot
	head   int // next slot to write
	length int // slots holding a sample, at most len(ring)

	// scratch is the sampler's read buffer; sample has one caller at a time, so no lock.
	scratch slot
}

// NewWindows builds the ring for spec; now is the clock (nil means time.Now). It
// rejects a non-positive Tick, a Horizon below Tick, an empty or duplicate name, and a nil source.
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

	spec.Histograms = append([]NamedHistogram(nil), spec.Histograms...)
	spec.MaxGauges = append([]NamedMaxGauge(nil), spec.MaxGauges...)
	spec.Counters = append([]NamedCounter(nil), spec.Counters...)

	// horizon/tick samples span the horizon; two more cover the base sample just outside it and a late tick.
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

// Run takes one baseline sample, then one per tick until ctx is cancelled. The
// returned channel closes once the goroutine exits, so shutdown can order it
// before the hub and database close.
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

// sample records one sample stamped now; allocation-free. Order matters: buckets
// are read first, interval maxima swapped after, and Observe stores its max
// before its count, so a counted observation's max is in this interval or an
// earlier one. One landing between the steps is counted once, though at a window
// edge its count and max can show in adjacent windows.
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
// is the newest sample at least d older, by timestamp not slot count, so a
// sampling gap widens Seconds instead of misattributing a long stretch; with
// none that old, the oldest held. False until two samples exist or d <= 0.
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
	// Half a tick of tolerance: a real ticker stamps slightly off the grid, so an
	// exact test would often miss the sample one tick back and cover d plus a tick
	// (70 s for "1m"). The two spare slots still hold the base for the longest window.
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
			delta[b] = satSub(newest.buckets[i*numBuckets+b], base.buckets[i*numBuckets+b])
			count += delta[b]
		}
		if count == 0 {
			// A racing observation can leave its max here and its count in the next sample; keep the max.
			out.Histograms[h.Name] = Summary{Max: float64(imax[i]) / 1000}
			continue
		}
		// Count is the sum of bucket deltas, not the histogram total, so a torn read cannot disagree with them.
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

// satSub is a-b, or 0 when b is larger: a reset cumulative figure reports no change, not a negative.
func satSub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}
