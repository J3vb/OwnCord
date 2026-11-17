// Package timering holds the fixed ring of timed samples that the stats
// samplers keep, and the window read and averaging they share. A Ring is not
// safe for concurrent use: the owner guards it with its own lock.
package timering

import "math"

// Ring keeps the newest len(buf) values, overwriting the oldest.
type Ring[T any] struct {
	buf  []T
	next int
	size int
}

// New returns an empty ring that holds up to size values.
func New[T any](size int) *Ring[T] {
	return &Ring[T]{buf: make([]T, size)}
}

// Push adds v, dropping the oldest value once the ring is full.
func (r *Ring[T]) Push(v T) {
	if len(r.buf) == 0 {
		return
	}
	r.buf[r.next] = v
	r.next = (r.next + 1) % len(r.buf)
	if r.size < len(r.buf) {
		r.size++
	}
}

// Newest returns the last value pushed, and false when the ring is empty.
func (r *Ring[T]) Newest() (T, bool) {
	if r.size == 0 {
		var zero T
		return zero, false
	}
	return r.buf[(r.next-1+len(r.buf))%len(r.buf)], true
}

// After returns, oldest first, the values whose time is later than from.
func (r *Ring[T]) After(from int64, at func(T) int64) []T {
	start := (r.next - r.size + len(r.buf)) % max(len(r.buf), 1)
	var out []T
	for i := range r.size {
		v := r.buf[(start+i)%len(r.buf)]
		if at(v) > from {
			out = append(out, v)
		}
	}
	return out
}

// Downsample averages consecutive runs of in so at most maxPoints remain;
// avg turns one run into its point.
func Downsample[T, P any](in []T, maxPoints int, avg func(run []T) P) []P {
	maxPoints = max(maxPoints, 1)
	step := max((len(in)+maxPoints-1)/maxPoints, 1)
	out := make([]P, 0, (len(in)+step-1)/step)
	for i := 0; i < len(in); i += step {
		out = append(out, avg(in[i:min(i+step, len(in))]))
	}
	return out
}

// Mean averages field over run, skipping NaN (a missing figure). It is NaN
// when every value is missing.
func Mean[T any](run []T, field func(T) float32) float32 {
	var sum float64
	var n int
	for _, s := range run {
		if v := field(s); !math.IsNaN(float64(v)) {
			sum += float64(v)
			n++
		}
	}
	if n == 0 {
		return float32(math.NaN())
	}
	return float32(sum / float64(n))
}
