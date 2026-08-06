package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

func okHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// TestRateLimitMiddlewareWithPrefix_SeparatesClientUpdateBucket locks the
// W2-1 fix: exhausting the client-update budget must not 429 the sensitive
// endpoints (verify-totp, password change) that ride the empty-prefix
// bucket for the same IP.
func TestRateLimitMiddlewareWithPrefix_SeparatesClientUpdateBucket(t *testing.T) {
	limiter := auth.NewRateLimiter()
	trustedProxies := []string{"127.0.0.0/8"}

	clientUpdate := rateLimitMiddlewareWithPrefix(limiter, "client_update:", 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))
	sensitive := RateLimitMiddleware(limiter, "totp_verify:", 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))

	newReq := func(path string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "127.0.0.1:9999"
		r.Header.Set("X-Forwarded-For", "203.0.113.7")
		return r
	}

	// Exhaust the client-update bucket for this IP.
	rec := httptest.NewRecorder()
	clientUpdate.ServeHTTP(rec, newReq("/client-update"))
	if rec.Code != http.StatusOK {
		t.Fatalf("first client-update status = %d, want 200", rec.Code)
	}
	rec = httptest.NewRecorder()
	clientUpdate.ServeHTTP(rec, newReq("/client-update"))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("second client-update status = %d, want 429", rec.Code)
	}

	// The same IP's sensitive-endpoint budget must be untouched.
	rec = httptest.NewRecorder()
	sensitive.ServeHTTP(rec, newReq("/api/v1/auth/verify-totp"))
	if rec.Code != http.StatusOK {
		t.Fatalf("sensitive endpoint shares the client-update bucket: status = %d, want 200", rec.Code)
	}
}

func TestRateLimitMiddlewareWithPrefix_SeparatesLiveKitBucket(t *testing.T) {
	limiter := auth.NewRateLimiter()
	trustedProxies := []string{"127.0.0.0/8"}

	livekit := rateLimitMiddlewareWithPrefix(limiter, "livekit_proxy:", 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))
	defaultRoute := RateLimitMiddleware(limiter, "login:", 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))

	firstLiveKit := httptest.NewRequest(http.MethodGet, "/livekit/rtc", nil)
	firstLiveKit.RemoteAddr = "127.0.0.1:9999"
	firstLiveKit.Header.Set("X-Forwarded-For", "198.51.100.10")
	firstLiveKitRec := httptest.NewRecorder()
	livekit.ServeHTTP(firstLiveKitRec, firstLiveKit)
	if firstLiveKitRec.Code != http.StatusOK {
		t.Fatalf("first livekit request status = %d, want 200", firstLiveKitRec.Code)
	}

	defaultReq := httptest.NewRequest(http.MethodGet, "/api/v1/auth/login", nil)
	defaultReq.RemoteAddr = "127.0.0.1:9999"
	defaultReq.Header.Set("X-Forwarded-For", "198.51.100.10")
	defaultRec := httptest.NewRecorder()
	defaultRoute.ServeHTTP(defaultRec, defaultReq)
	if defaultRec.Code != http.StatusOK {
		t.Fatalf("default route should not share the livekit bucket, got %d", defaultRec.Code)
	}

	secondLiveKit := httptest.NewRequest(http.MethodGet, "/livekit/rtc", nil)
	secondLiveKit.RemoteAddr = "127.0.0.1:9999"
	secondLiveKit.Header.Set("X-Forwarded-For", "198.51.100.10")
	secondLiveKitRec := httptest.NewRecorder()
	livekit.ServeHTTP(secondLiveKitRec, secondLiveKit)
	if secondLiveKitRec.Code != http.StatusTooManyRequests {
		t.Fatalf("second livekit request status = %d, want 429", secondLiveKitRec.Code)
	}

	differentClient := httptest.NewRequest(http.MethodGet, "/livekit/rtc", nil)
	differentClient.RemoteAddr = "127.0.0.1:9999"
	differentClient.Header.Set("X-Forwarded-For", "198.51.100.11")
	differentClientRec := httptest.NewRecorder()
	livekit.ServeHTTP(differentClientRec, differentClient)
	if differentClientRec.Code != http.StatusOK {
		t.Fatalf("different forwarded client should have a separate livekit bucket, got %d", differentClientRec.Code)
	}
}
