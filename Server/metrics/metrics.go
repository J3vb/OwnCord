// Package metrics provides stdlib-only, allocation-free in-process metric
// primitives behind GET /api/v1/metrics and the support bundle. They are
// separate from Server/telemetry's OTel instruments, which exist only under
// -tags otel and so are invisible to operators on the untagged release builds.
package metrics

import (
	"math"
	"sync/atomic"
)

// latencyBoundsMs are the shared histogram bucket upper bounds in milliseconds,
// an array so len() is a compile-time constant.
var latencyBoundsMs = [...]float64{0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000}

// Summary is a read-side snapshot of a Histogram. P50/P95/P99 are the upper
// bound of the quantile's bucket, capped at Max: coarse; Max is exact.
type Summary struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

// Histogram is a fixed-bucket, lock-free latency histogram. The zero value is
// usable; do not copy it after first use (atomic buckets).
type Histogram struct {
	buckets [numBuckets]atomic.Uint64 // last bucket is +Inf
	total   atomic.Uint64
	max     atomic.Uint64 // microseconds, lifetime
	// sum is every observation in microseconds (the exposition's _sum).
	sum atomic.Uint64
	// intervalMax is the largest observation since the last takeIntervalMax, in
	// microseconds; only the Windows sampler resets it, never the lifetime max.
	intervalMax atomic.Uint64
}

const numBuckets = len(latencyBoundsMs) + 1

// Counts is a raw read of a Histogram's cumulative state.
type Counts struct {
	Buckets   [numBuckets]uint64 // last bucket is +Inf
	SumMicros uint64
}

// Observe records one observation in milliseconds, allocation-free.
func (h *Histogram) Observe(ms float64) {
	if ms < 0 || math.IsNaN(ms) {
		ms = 0
	}
	i := len(latencyBoundsMs) // +Inf bucket
	for j, bound := range latencyBoundsMs {
		if ms <= bound {
			i = j
			break
		}
	}
	// Maxima are stored BEFORE the counts: the sampler reads buckets then swaps
	// intervalMax, so a counted observation's max is in its interval or an earlier
	// one (at a boundary the two can land in adjacent windows).
	micros := uint64(ms * 1000)
	atomicMax(&h.max, micros)
	atomicMax(&h.intervalMax, micros)
	h.buckets[i].Add(1)
	h.total.Add(1)
	h.sum.Add(micros)
}

// Counts returns cumulative bucket counts and the sum in microseconds. Buckets
// only grow, so a later Counts minus an earlier one is never negative; the
// reads are individually atomic, not one consistent cut.
func (h *Histogram) Counts() Counts {
	var c Counts
	for i := range h.buckets {
		c.Buckets[i] = h.buckets[i].Load()
	}
	c.SumMicros = h.sum.Load()
	return c
}

func (h *Histogram) readBuckets(dst *[numBuckets]uint64) {
	for i := range h.buckets {
		dst[i] = h.buckets[i].Load()
	}
}

// takeIntervalMax returns the largest observation (microseconds) since the previous call and resets it;
// Windows sampler only.
func (h *Histogram) takeIntervalMax() uint64 { return h.intervalMax.Swap(0) }

// Snapshot returns the current distribution; empty yields the zero Summary.
func (h *Histogram) Snapshot() Summary {
	total := h.total.Load()
	if total == 0 {
		return Summary{}
	}
	var buckets [numBuckets]uint64
	h.readBuckets(&buckets)
	maxMicros := h.max.Load()
	return Summary{
		Count: total,
		P50:   quantile(&buckets, total, maxMicros, 0.50),
		P95:   quantile(&buckets, total, maxMicros, 0.95),
		P99:   quantile(&buckets, total, maxMicros, 0.99),
		Max:   float64(maxMicros) / 1000,
	}
}

// quantile returns the upper bound of the bucket holding the q-quantile, capped
// at maxMicros (the exact max in the +Inf bucket). Pure.
func quantile(buckets *[numBuckets]uint64, total, maxMicros uint64, q float64) float64 {
	target := uint64(math.Ceil(float64(total) * q))
	maxMs := float64(maxMicros) / 1000
	var cumulative uint64
	for i := range latencyBoundsMs {
		cumulative += buckets[i]
		if cumulative >= target {
			return min(latencyBoundsMs[i], maxMs)
		}
	}
	return maxMs
}

// MaxGauge holds the largest value observed since start, in milliseconds; the
// zero value is usable (e.g. hub_seqmu_max_hold_ms).
type MaxGauge struct {
	micros atomic.Uint64
	// intervalMax: see Histogram.intervalMax.
	intervalMax atomic.Uint64
}

// Observe records ms if it is the new maximum; negative and NaN are ignored.
func (g *MaxGauge) Observe(ms float64) {
	if ms < 0 || math.IsNaN(ms) {
		return
	}
	micros := uint64(ms * 1000)
	atomicMax(&g.micros, micros)
	atomicMax(&g.intervalMax, micros)
}

// takeIntervalMax returns the largest value (microseconds) since the previous call and resets it; Windows
// sampler only.
func (g *MaxGauge) takeIntervalMax() uint64 { return g.intervalMax.Swap(0) }

// Millis returns the largest value observed, in milliseconds.
func (g *MaxGauge) Millis() float64 { return float64(g.micros.Load()) / 1000 }

func atomicMax(p *atomic.Uint64, v uint64) {
	for {
		cur := p.Load()
		if v <= cur || p.CompareAndSwap(cur, v) {
			return
		}
	}
}
