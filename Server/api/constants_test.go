package api

import "testing"

// I-7: loginRateLimitPerMinute must be 5 (not 60).
func TestLoginRateLimit_Value(t *testing.T) {
	if loginRateLimitPerMinute != 5 {
		t.Errorf("loginRateLimitPerMinute = %d, want 5", loginRateLimitPerMinute)
	}
}
