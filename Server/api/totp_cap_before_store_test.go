package api_test

// Codex P2 on PR #1454 (B3-9, OC-0377): once a user's totp_fail cap is
// exhausted, verify-totp must refuse before it loads the user and decrypts
// the secret — otherwise rotating source IPs (the per-user cap is the only
// cross-IP defence) could drive store reads and decryptions without bound.
// The read-only Check runs ahead of the store read; the atomic Allow that
// records the attempt still sits after it, so an outage charges nothing.

import (
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestVerifyTOTP_ExhaustedCapRefusesBeforeStoreRead(t *testing.T) {
	database := newAuthTestDB(t)
	limiter := auth.NewRateLimiter()
	router := buildAuthRouter(database, limiter)
	uid := seedUser(t, database, "capped", "correctPass1", 4)
	secret := enrolTOTP(t, database, uid)
	pt := loginPartial(t, router, "capped", "correctPass1", "", "")

	// Exhaust the per-user budget (service: totpFailureRateLimit = 10 in
	// totpFailureWindow = 15 min) without a single HTTP failure.
	for range 10 {
		limiter.Allow(auth.Key("totp_fail", uid), 10, 15*time.Minute)
	}
	// Every user read now fails; an attempt that reaches the store answers
	// 500 "two-factor verification temporarily unavailable" (OC-0377).
	hideTable(t, database, "users")

	rr := send(t, router, http.MethodPost, "/api/v1/auth/verify-totp", pt, "203.0.113.50", "", map[string]string{"code": totpCode(t, secret)})
	wantErr(t, rr, http.StatusTooManyRequests, "RATE_LIMITED", "too many failed attempts, try again later")
}
