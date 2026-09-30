package service

import (
	"fmt"
	"time"
)

// minTimeoutDuration and maxTimeoutDuration bound Timeout's duration
// (decision 6): 1 minute to 28 days.
const (
	minTimeoutDuration = time.Minute
	maxTimeoutDuration = 28 * 24 * time.Hour
)

// TimeoutDurationFromSeconds bounds a raw client-supplied `duration_seconds`
// before converting it to a Duration. The API handlers used to multiply by
// time.Second first and let Timeout's range check inspect the product; a
// Duration is an int64 nanosecond count, so that multiply wraps modulo 2^64
// and a value like 36028797018967568 (3600 + 2^55) collapses to exactly one
// hour, passing the 1-minute..28-day gate as a request the caller never made
// (OC-0485). Checking the seconds first refuses it as bad input, and one
// helper serves both entry points (the direct timeout route and ActOnReport)
// so the check cannot drift between them.
func TimeoutDurationFromSeconds(seconds int64) (time.Duration, error) {
	if seconds < int64(minTimeoutDuration/time.Second) || seconds > int64(maxTimeoutDuration/time.Second) {
		return 0, fmt.Errorf("%w: duration must be between 1 minute and 28 days", ErrBadRequest)
	}
	return time.Duration(seconds) * time.Second, nil
}
