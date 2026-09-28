package service

import (
	"errors"
	"testing"
	"time"
)

// TestTimeoutDurationFromSeconds_RejectsOverflow is OC-0485: a raw client
// int64 `duration_seconds` was multiplied by time.Second before any range
// check, so a value like 36028797018967568 (3600 + 2^55) wrapped modulo 2^64
// to exactly one hour and passed the 1-minute..28-day gate. The check must
// run against the raw seconds, before the multiply, so an out-of-range value
// is refused rather than silently shrunk.
func TestTimeoutDurationFromSeconds_RejectsOverflow(t *testing.T) {
	if _, err := TimeoutDurationFromSeconds(36028797018967568); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("overflowing seconds must be refused as bad input, got %v", err)
	}
	// The whole int64 range outside [min,max] must be refused, including
	// values whose product happens to land back inside the window.
	for _, s := range []int64{
		int64(minTimeoutDuration/time.Second) - 1,
		int64(maxTimeoutDuration/time.Second) + 1,
		-1,
		-36028797018963968,
		1 << 40,
		-(1 << 62),
	} {
		if _, err := TimeoutDurationFromSeconds(s); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("seconds %d must be refused, got %v", s, err)
		}
	}
}

// TestTimeoutDurationFromSeconds_AcceptsTheWindow pins the boundary values the
// API promises (60..2419200) so the bounds check cannot be tightened wrongly.
func TestTimeoutDurationFromSeconds_AcceptsTheWindow(t *testing.T) {
	for _, s := range []int64{60, 3600, 2419200} {
		d, err := TimeoutDurationFromSeconds(s)
		if err != nil {
			t.Fatalf("seconds %d must be accepted, got %v", s, err)
		}
		if want := time.Duration(s) * time.Second; d != want {
			t.Fatalf("seconds %d produced %v, want %v", s, d, want)
		}
	}
}
