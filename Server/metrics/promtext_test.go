package metrics

import (
	"math"
	"strings"
	"testing"
)

// TestPromText_HistogramShape pins the conversion: millisecond bounds become
// seconds, buckets are cumulative, +Inf equals _count, and _sum is seconds.
func TestPromText_HistogramShape(t *testing.T) {
	var h Histogram
	h.Observe(0.4)  // <= 0.5 ms bucket
	h.Observe(3)    // <= 5 ms bucket
	h.Observe(3)    // <= 5 ms bucket
	h.Observe(9000) // +Inf bucket
	var p PromText
	p.Family("x_seconds", PromHistogram, "x.")
	p.Histogram([]PromLabel{{Name: "phase", Value: "a"}}, h.Counts())

	want := []string{
		"# HELP x_seconds x.",
		"# TYPE x_seconds histogram",
		`x_seconds_bucket{phase="a",le="0.0005"} 1`,
		`x_seconds_bucket{phase="a",le="0.001"} 1`,
		`x_seconds_bucket{phase="a",le="0.002"} 1`,
		`x_seconds_bucket{phase="a",le="0.005"} 3`,
		`x_seconds_bucket{phase="a",le="0.01"} 3`,
		`x_seconds_bucket{phase="a",le="0.02"} 3`,
		`x_seconds_bucket{phase="a",le="0.05"} 3`,
		`x_seconds_bucket{phase="a",le="0.1"} 3`,
		`x_seconds_bucket{phase="a",le="0.2"} 3`,
		`x_seconds_bucket{phase="a",le="0.5"} 3`,
		`x_seconds_bucket{phase="a",le="1"} 3`,
		`x_seconds_bucket{phase="a",le="2"} 3`,
		`x_seconds_bucket{phase="a",le="5"} 3`,
		`x_seconds_bucket{phase="a",le="+Inf"} 4`,
		`x_seconds_sum{phase="a"} 9.0064`,
		`x_seconds_count{phase="a"} 4`,
		"",
	}
	got := strings.Split(string(p.Bytes()), "\n")
	if len(got) != len(want) {
		t.Fatalf("got %d lines, want %d:\n%s", len(got), len(want), p.Bytes())
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestPromText_BoundsMatchHistogramBuckets keeps the writer in step with the
// histogram: one le line per bound, the buckets counted from the same array.
func TestPromText_BoundsMatchHistogramBuckets(t *testing.T) {
	var p PromText
	p.Family("y_seconds", PromHistogram, "y.")
	p.Histogram(nil, Counts{})
	if n := strings.Count(string(p.Bytes()), "y_seconds_bucket{"); n != len(latencyBoundsMs)+1 {
		t.Fatalf("bucket lines = %d, want %d", n, len(latencyBoundsMs)+1)
	}
}

func TestPromText_HelpEscaping(t *testing.T) {
	var p PromText
	p.Family("z", PromGauge, "a\\b\nc")
	p.Sample(nil, 1)
	want := "# HELP z a\\\\b\\nc\n# TYPE z gauge\nz 1\n"
	if got := string(p.Bytes()); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestPromText_FloatFormatting(t *testing.T) {
	cases := map[float64]string{
		0: "0", 1: "1", 0.5: "0.5", 1.5e9: "1.5e+09", 0.0005: "0.0005",
		math.Inf(1): "+Inf", math.Inf(-1): "-Inf", math.NaN(): "NaN",
	}
	for v, want := range cases {
		var p PromText
		p.Family("f", PromGauge, "f.")
		p.Sample(nil, v)
		if got := strings.TrimSuffix(strings.SplitN(string(p.Bytes()), "\n", 3)[2], "\n"); got != "f "+want {
			t.Errorf("Sample(%v) = %q, want %q", v, got, "f "+want)
		}
	}
}
