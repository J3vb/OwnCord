package metrics

import (
	"encoding/json"
	"testing"
)

// TestHistogram_QuantilesAndMax pins the bucket-boundary contract: an
// observation lands in the first bucket whose bound it does not exceed, the
// reported quantiles are that bucket's upper bound, and Max is exact.
func TestHistogram_QuantilesAndMax(t *testing.T) {
	var h Histogram
	for range 100 {
		h.Observe(3) // bucket bound 5
	}
	h.Observe(750) // bucket bound 1000, and the exact max

	s := h.Snapshot()
	if s.Count != 101 {
		t.Fatalf("count = %d, want 101", s.Count)
	}
	if s.P50 != 5 || s.P95 != 5 || s.P99 != 5 {
		t.Fatalf("p50/p95/p99 = %v/%v/%v, want 5/5/5", s.P50, s.P95, s.P99)
	}
	if s.Max != 750 {
		t.Fatalf("max = %v, want 750", s.Max)
	}
}

// A quantile never reads above the exact max, even when the max sits below
// its bucket's upper bound.
func TestHistogram_QuantilesCappedAtMax(t *testing.T) {
	var h Histogram
	h.Observe(3.1) // bucket bound 5
	s := h.Snapshot()
	if s.P50 != 3.1 || s.P95 != 3.1 || s.P99 != 3.1 || s.Max != 3.1 {
		t.Fatalf("p50/p95/p99/max = %v/%v/%v/%v, want 3.1 for all", s.P50, s.P95, s.P99, s.Max)
	}
}

func TestHistogram_EmptyIsZero(t *testing.T) {
	var h Histogram
	if got := h.Snapshot(); got.Count != 0 || got.Max != 0 {
		t.Fatalf("empty snapshot = %+v, want zero", got)
	}
}

// TestHistogram_InfiniteBucketFallsBackToExactMax covers an observation past
// the largest bound: the quantile cannot name a bound, so it reports the exact
// max rather than +Inf.
func TestHistogram_InfiniteBucketFallsBackToExactMax(t *testing.T) {
	var h Histogram
	h.Observe(9000)
	s := h.Snapshot()
	if s.P99 != 9000 || s.Max != 9000 {
		t.Fatalf("p99/max = %v/%v, want 9000/9000", s.P99, s.Max)
	}
}

func TestMaxGauge_KeepsLargest(t *testing.T) {
	var g MaxGauge
	g.Observe(10)
	g.Observe(200)
	g.Observe(50)
	if got := g.Millis(); got != 200 {
		t.Fatalf("Millis = %v, want 200", got)
	}
}

// TestSummary_JSONShape pins the wire names the metrics endpoint and the load
// run's metrics-after.json read.
func TestSummary_JSONShape(t *testing.T) {
	b, err := json.Marshal(Summary{Count: 3, P50: 1, P95: 2, P99: 5, Max: 8})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"count":3,"p50":1,"p95":2,"p99":5,"max":8}`
	if string(b) != want {
		t.Fatalf("json = %s, want %s", b, want)
	}
}
