package api

import (
	"os"
	"strings"
	"testing"
)

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

// setAuthRateScale/scaledAuthLimit gate every per-IP auth limit
// (auth_handler.go:107-136) and the per-IP login failure threshold that arms
// the lockout (auth_handler.go:514,537). The multiplier is operator-supplied
// via security.auth_rate_limit_multiplier and config validates nothing, so
// this clamp is all that stands between a typo and brute-force protection
// disappearing.
func TestSetAuthRateScale_ClampsMultiplier(t *testing.T) {
	t.Cleanup(func() { setAuthRateScale(1.0) })

	tests := []struct {
		name  string
		mult  float64
		limit int
		want  int
	}{
		{"unset config means 1x", 0, loginRateLimitPerMinute, 5},
		{"negative means 1x", -3.5, loginRateLimitPerMinute, 5},
		{"1x leaves the limit alone", 1, registerRateLimitPerMinute, 3},
		{"above the cap clamps to 100x", 1e9, loginRateLimitPerMinute, 500},
		{"at the cap is 100x", 100, loginRateLimitPerMinute, 500},
		{"below the floor clamps to 0.1x", 1e-9, verifyTOTPRateLimitPerMinute, 1},
		{"at the floor is 0.1x", 0.1, verifyTOTPRateLimitPerMinute, 1},
		{"in range scales and rounds", 0.5, loginRateLimitPerMinute, 3},
		{"in range scales the failure threshold", 2, loginFailureThreshold, 18},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			setAuthRateScale(tt.mult)
			if got := scaledAuthLimit(tt.limit); got != tt.want {
				t.Errorf("setAuthRateScale(%v); scaledAuthLimit(%d) = %d, want %d",
					tt.mult, tt.limit, got, tt.want)
			}
		})
	}
}

// A limit of 0 lets nothing through: on the login failure threshold
// (auth_handler.go:514) that locks every IP out on its first attempt. The
// smallest allowed multiplier must still leave every scaled limit usable.
func TestScaledAuthLimit_NeverBelowOne(t *testing.T) {
	t.Cleanup(func() { setAuthRateScale(1.0) })
	setAuthRateScale(0.1)

	for _, n := range []int{
		1,
		registerRateLimitPerMinute,
		loginRateLimitPerMinute,
		verifyTOTPRateLimitPerMinute,
		sensitiveEndpointRateLimitPerMinute,
		loginFailureThreshold,
	} {
		if got := scaledAuthLimit(n); got < 1 {
			t.Errorf("scaledAuthLimit(%d) = %d at the 0.1x floor, want >= 1", n, got)
		}
	}
}

// The multiplier exists for shared-NAT *per-IP* limits. The per-user caps are
// the only cross-IP brute-force defence, so scaling them would hand a
// distributed attacker up to 100x the guesses (totp_handler.go:76-80). Those
// caps are only observable through a limiter key inside the handler, so this
// pins the call site instead.
func TestPerUserFailureCapsStayUnscaled(t *testing.T) {
	for file, constants := range map[string][]string{
		"totp_handler.go": {"totpFailureRateLimit"},
		"auth_handler.go": {"loginUserFailureThreshold"},
	} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		for _, c := range constants {
			if strings.Contains(string(src), "scaledAuthLimit("+c) {
				t.Errorf("%s scales %s with the per-IP auth multiplier; per-user caps must stay unscaled",
					file, c)
			}
		}
	}
}
