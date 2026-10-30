package auth

import (
	"math"
	"sync/atomic"
)

// rateScaleBits holds security.auth_rate_limit_multiplier as float bits. It
// scales per-IP auth caps and failure thresholds for deployments where many
// users share one IP (the compiled-in limits assume about one person per
// address). Atomic because tests build routers concurrently. Installed by
// api.NewRouter via SetRateScale.
var rateScaleBits atomic.Uint64

func init() { rateScaleBits.Store(math.Float64bits(1.0)) }

// SetRateScale clamps and installs the auth rate multiplier. Zero or
// negative (unset config) means 1.0.
func SetRateScale(m float64) {
	if m <= 0 {
		m = 1.0
	}
	m = math.Min(math.Max(m, 0.1), 100)
	rateScaleBits.Store(math.Float64bits(m))
}

// ScaledLimit applies the auth rate multiplier to a compiled-in limit, never
// returning less than 1. Per-user caps must not go through it: they are the
// only cross-IP brute-force defence, and the multiplier exists for shared-NAT
// per-IP limits.
func ScaledLimit(n int) int {
	scaled := int(math.Round(float64(n) * math.Float64frombits(rateScaleBits.Load())))
	if scaled < 1 {
		return 1
	}
	return scaled
}
