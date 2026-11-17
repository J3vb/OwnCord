package timering

import (
	"math"
	"slices"
	"testing"
)

func at(v int64) int64 { return v }

func TestRingKeepsTheNewestValues(t *testing.T) {
	t.Parallel()
	r := New[int64](3)
	if _, ok := r.Newest(); ok {
		t.Fatal("an empty ring has no newest value")
	}
	for v := range int64(5) {
		r.Push(v + 1)
	}
	if got, ok := r.Newest(); !ok || got != 5 {
		t.Fatalf("Newest() = %d, %v; want 5, true", got, ok)
	}
	if got := r.After(0, at); !slices.Equal(got, []int64{3, 4, 5}) {
		t.Fatalf("After(0) = %v; want [3 4 5]", got)
	}
	if got := r.After(3, at); !slices.Equal(got, []int64{4, 5}) {
		t.Fatalf("After(3) = %v; want [4 5]", got)
	}
}

func TestZeroSizeRingStaysEmpty(t *testing.T) {
	t.Parallel()
	r := New[int64](0)
	r.Push(1)
	if _, ok := r.Newest(); ok {
		t.Fatal("a zero-size ring keeps nothing")
	}
	if got := r.After(0, at); len(got) != 0 {
		t.Fatalf("After(0) = %v; want none", got)
	}
}

func TestDownsampleAveragesRuns(t *testing.T) {
	t.Parallel()
	in := []float32{1, 3, 5, 7, 9}
	sum := func(run []float32) float32 { return Mean(run, func(v float32) float32 { return v }) }
	if got := Downsample(in, 2, sum); !slices.Equal(got, []float32{3, 8}) {
		t.Fatalf("Downsample(2) = %v; want [3 8]", got)
	}
	if got := Downsample(in, 0, sum); !slices.Equal(got, []float32{5}) {
		t.Fatalf("Downsample(0) = %v; want [5]", got)
	}
	if got := Downsample(nil, 4, sum); len(got) != 0 {
		t.Fatalf("Downsample(nil) = %v; want none", got)
	}
}

func TestMeanSkipsMissingFigures(t *testing.T) {
	t.Parallel()
	nan := float32(math.NaN())
	id := func(v float32) float32 { return v }
	if got := Mean([]float32{2, nan, 4}, id); got != 3 {
		t.Fatalf("Mean = %v; want 3", got)
	}
	if got := Mean([]float32{nan, nan}, id); !math.IsNaN(float64(got)) {
		t.Fatalf("Mean of missing values = %v; want NaN", got)
	}
}
