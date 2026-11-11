package auth

import (
	"math"
	"sync/atomic"
)

// rateScaleBits holds security.auth_rate_limit_multiplier as float bits, scaling
// per-IP auth limits for deployments where many users share one IP. Atomic
// because tests build routers concurrently.
var rateScaleBits atomic.Uint64

func init() { rateScaleBits.Store(math.Float64bits(1.0)) }

// SetRateScale clamps and installs the multiplier; zero or negative means 1.0.
func SetRateScale(m float64) {
	if m <= 0 {
		m = 1.0
	}
	m = math.Min(math.Max(m, 0.1), 100)
	rateScaleBits.Store(math.Float64bits(m))
}

// ScaledLimit applies the multiplier to a limit, never below 1. Per-user caps
// must not use it: they are the only cross-IP brute-force defence.
func ScaledLimit(n int) int {
	scaled := int(math.Round(float64(n) * math.Float64frombits(rateScaleBits.Load())))
	if scaled < 1 {
		return 1
	}
	return scaled
}
