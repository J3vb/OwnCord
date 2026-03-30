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

func TestRateLimitMiddlewareWithPrefix_SeparatesLiveKitBucket(t *testing.T) {
	limiter := auth.NewRateLimiter()
	trustedProxies := []string{"127.0.0.0/8"}

	livekit := rateLimitMiddlewareWithPrefix(limiter, "livekit_proxy:", 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))
	defaultRoute := RateLimitMiddleware(limiter, 1, time.Minute, trustedProxies)(http.HandlerFunc(okHandler))

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
