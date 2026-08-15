package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunHealthChecks_AllHealthy(t *testing.T) {
	status, reason := runHealthChecks(context.Background(), healthDeps{
		dbPing:        func(context.Context) error { return nil },
		dispatchAlive: func() bool { return true },
		freeDiskBytes: func() (uint64, error) { return 10 << 30, nil },
	})
	if status != "ok" || reason != "" {
		t.Fatalf("got (%q, %q), want (ok, \"\")", status, reason)
	}
}

func TestRunHealthChecks_HubDeadWinsFirst(t *testing.T) {
	status, reason := runHealthChecks(context.Background(), healthDeps{
		dbPing:        func(context.Context) error { return errors.New("also down") },
		dispatchAlive: func() bool { return false },
	})
	if status != "degraded" || reason != "hub" {
		t.Fatalf("got (%q, %q), want (degraded, hub)", status, reason)
	}
}

func TestRunHealthChecks_DBError(t *testing.T) {
	status, reason := runHealthChecks(context.Background(), healthDeps{
		dbPing:        func(context.Context) error { return errors.New("locked") },
		dispatchAlive: func() bool { return true },
	})
	if status != "degraded" || reason != "database" {
		t.Fatalf("got (%q, %q), want (degraded, database)", status, reason)
	}
}

func TestRunHealthChecks_LowDisk(t *testing.T) {
	status, reason := runHealthChecks(context.Background(), healthDeps{
		freeDiskBytes: func() (uint64, error) { return 1 << 20, nil }, // 1 MiB
	})
	if status != "degraded" || reason != "disk" {
		t.Fatalf("got (%q, %q), want (degraded, disk)", status, reason)
	}
}

// TestRunHealthChecks_UnknownProbesCountHealthy locks the "unknown ≠ full"
// rule: a probe error (unsupported platform, missing dir) must not degrade.
func TestRunHealthChecks_UnknownProbesCountHealthy(t *testing.T) {
	status, _ := runHealthChecks(context.Background(), healthDeps{
		freeDiskBytes: func() (uint64, error) { return 0, errors.New("no statfs here") },
	})
	if status != "ok" {
		t.Fatalf("probe error degraded health: got %q, want ok", status)
	}
}

func TestHandleHealth_DegradedReturns503WithReason(t *testing.T) {
	h := handleHealth(healthDeps{
		onlineUsers:   func() int { return 3 },
		dispatchAlive: func() bool { return false },
	})
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	var resp healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "degraded" || resp.Reason != "hub" {
		t.Errorf("body = %+v, want status=degraded reason=hub", resp)
	}
	if resp.OnlineUsers != 3 {
		t.Errorf("online_users = %d, want 3", resp.OnlineUsers)
	}
}

// TestHandleHealth_CanceledRequestDoesNotPoisonCache locks the WithoutCancel
// guard: a probe that disconnects mid-request must not stamp a false
// "degraded/database" verdict into the shared 5s cache.
func TestHandleHealth_CanceledRequestDoesNotPoisonCache(t *testing.T) {
	h := handleHealth(healthDeps{
		dbPing: func(ctx context.Context) error { return ctx.Err() },
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // client already gone
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/health", nil).WithContext(ctx))
	if rec.Code != http.StatusOK {
		t.Fatalf("canceled request produced %d; its cancellation leaked into the cached checks", rec.Code)
	}
}

// TestHandleHealth_ChecksAreCached locks the amplification guard: the endpoint
// is unauthenticated and rate-limit-exempt, so the real checks must run at
// most once per healthCacheTTL, not per request.
func TestHandleHealth_ChecksAreCached(t *testing.T) {
	pings := 0
	h := handleHealth(healthDeps{
		dbPing: func(context.Context) error { pings++; return nil },
	})
	for range 5 {
		rec := httptest.NewRecorder()
		h(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	}
	if pings != 1 {
		t.Fatalf("dbPing ran %d times across 5 requests, want 1 (cached)", pings)
	}
}
