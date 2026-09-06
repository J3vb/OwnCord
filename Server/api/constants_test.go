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

// The rate-limiter reaper used to delete any window entry whose timestamps
// were all older than one server-wide rateLimiterCleanupMaxWindow horizon —
// safe only for windows no longer than that horizon (N2, B5-10 review), and
// impossible to size correctly for every caller at once: short enough to
// reclaim a minutes-long window promptly, or long enough to cover
// service.AppealRateWindow's 24h cap, never both (the exact trade-off that
// made the horizon approach wrong). Cleanup is per-key-window-aware now
// (item 6, round 3 review: auth/ratelimit.go's entry.window) — there is no
// shared horizon left to size, so there is nothing left to test here. The
// meaningful regression guard moved to
// auth.TestRateLimiter_CleanupHorizonShorterThanWindowForgetsHistory, which
// asserts the actual BEHAVIOR (a 7h-old appeal submission survives a
// Cleanup sweep) against service.AppealRateWindow, the real exported
// production constant, rather than a local literal that could drift from
// it silently.

// setAuthRateScale/scaledAuthLimit gate every per-IP auth limit
// (auth_handler.go MountAuthRoutes) and, through auth.ScaledLimit, the per-IP
// login failure threshold that arms the lockout (service/auth.go
// authenticate). The multiplier is operator-supplied
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
		{"in range scales the failure threshold", 2, 9, 18}, // 9 = service/auth.go loginFailureThreshold
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
// (service/auth.go authenticate) that locks every IP out on its first attempt. The
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
		9, // service/auth.go loginFailureThreshold
	} {
		if got := scaledAuthLimit(n); got < 1 {
			t.Errorf("scaledAuthLimit(%d) = %d at the 0.1x floor, want >= 1", n, got)
		}
	}
}

// The multiplier exists for shared-NAT *per-IP* limits. The per-user caps are
// the only cross-IP brute-force defence, so scaling them would hand a
// distributed attacker up to 100x the guesses (service/auth.go VerifyTOTP).
// Those caps are only observable through a limiter key inside the service, so
// this pins the call site instead.
func TestPerUserFailureCapsStayUnscaled(t *testing.T) {
	for file, constants := range map[string][]string{
		"../service/auth.go": {"totpFailureRateLimit", "loginUserFailureThreshold"},
	} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		for _, c := range constants {
			if strings.Contains(string(src), "ScaledLimit("+c) || strings.Contains(string(src), "scaledAuthLimit("+c) {
				t.Errorf("%s scales %s with the per-IP auth multiplier; per-user caps must stay unscaled",
					file, c)
			}
		}
	}
}
