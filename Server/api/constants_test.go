package api

import "testing"

// I-7: loginRateLimitPerMinute must be 5 (not 60).
func TestLoginRateLimit_Value(t *testing.T) {
	if loginRateLimitPerMinute != 5 {
		t.Errorf("loginRateLimitPerMinute = %d, want 5", loginRateLimitPerMinute)
	}
}

// The rate-limiter reaper deletes any window entry whose timestamps are all
// older than rateLimiterCleanupMaxWindow, which is only safe for windows no
// longer than that horizon (auth/ratelimit.go). Slow mode uses the limiter
// with windows up to admin's maxSlowModeSeconds (21600 s = 6 h), so a shorter
// horizon silently resets long slow modes after ~15 minutes.
func TestRateLimiterCleanupHorizon_CoversMaxSlowMode(t *testing.T) {
	const maxSlowMode = 21600 // admin/handlers_channels.go maxSlowModeSeconds
	if rateLimiterCleanupMaxWindow.Seconds() < maxSlowMode {
		t.Errorf("rateLimiterCleanupMaxWindow = %v, must cover the %ds slow-mode cap",
			rateLimiterCleanupMaxWindow, maxSlowMode)
	}
}
