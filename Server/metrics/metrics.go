// Package metrics provides the small, stdlib-only, allocation-free in-process
// metric primitives behind GET /api/v1/metrics and the support bundle.
//
// They are deliberately separate from the OpenTelemetry instruments in
// Server/telemetry: the OTel SDK is compiled only under -tags otel, and the
// shipped release and Docker builds use no build tags, so an OTel-only latency
// figure is invisible to every operator who did not rebuild the server
// (SRE-M1). A fixed-bucket histogram and an atomic max cost no allocation on
// the hot path and need no dependency.
package metrics

import (
	"math"
	"sync/atomic"
)

// latencyBoundsMs are the shared histogram bucket upper bounds, in
// milliseconds: sub-millisecond fan-out work through multi-second stalls.
// Because this is an array (not a slice) len() is a compile-time constant, so
// the Histogram's bucket array can size itself from it.
var latencyBoundsMs = [...]float64{0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000}

// Summary is a read-side snapshot of a Histogram. P50/P95/P99 are the upper
// bound of the bucket the quantile falls into — a coarse but operator-usable
// estimate from a fixed-bucket histogram; Max is exact.
type Summary struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

// Histogram is a fixed-bucket, lock-free latency histogram. The zero value is
// usable and starts empty; it must not be copied after first use (its buckets
// are atomics).
type Histogram struct {
	buckets [len(latencyBoundsMs) + 1]atomic.Uint64 // last bucket is +Inf
	total   atomic.Uint64
	max     atomic.Uint64 // microseconds
}

// Observe records one observation, in milliseconds. Allocation-free.
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
	h.buckets[i].Add(1)
	h.total.Add(1)
	atomicMax(&h.max, uint64(ms*1000))
}

// Snapshot returns the current distribution. A histogram with no observations
// reports the zero Summary.
func (h *Histogram) Snapshot() Summary {
	total := h.total.Load()
	if total == 0 {
		return Summary{}
	}
	return Summary{
		Count: total,
		P50:   h.quantile(total, 0.50),
		P95:   h.quantile(total, 0.95),
		P99:   h.quantile(total, 0.99),
		Max:   float64(h.max.Load()) / 1000,
	}
}

// quantile returns the upper bound of the bucket holding the q-quantile. When
// the quantile lands in the +Inf bucket it falls back to the exact max.
func (h *Histogram) quantile(total uint64, q float64) float64 {
	target := uint64(math.Ceil(float64(total) * q))
	var cumulative uint64
	for i := range latencyBoundsMs {
		cumulative += h.buckets[i].Load()
		if cumulative >= target {
			return latencyBoundsMs[i]
		}
	}
	return float64(h.max.Load()) / 1000
}

// MaxGauge holds the largest value observed since start, in milliseconds. Like
// Histogram its zero value is usable. It is the shape a "worst single hold"
// figure needs (hub_seqmu_max_hold_ms).
type MaxGauge struct {
	micros atomic.Uint64
}

// Observe records ms if it is the new maximum. Negative and NaN values are
// ignored. Allocation-free.
func (g *MaxGauge) Observe(ms float64) {
	if ms < 0 || math.IsNaN(ms) {
		return
	}
	atomicMax(&g.micros, uint64(ms*1000))
}

// Millis returns the largest value observed, in milliseconds.
func (g *MaxGauge) Millis() float64 { return float64(g.micros.Load()) / 1000 }

// atomicMax stores v into *p when v exceeds the current value.
func atomicMax(p *atomic.Uint64, v uint64) {
	for {
		cur := p.Load()
		if v <= cur || p.CompareAndSwap(cur, v) {
			return
		}
	}
}
