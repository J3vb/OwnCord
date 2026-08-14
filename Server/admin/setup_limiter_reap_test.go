package admin_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/auth"
)

// TestSetupLimiter_ReapsStaleEntries pins OC-0076: setupLimiter — the
// dedicated auth.RateLimiter behind POST /setup — is never reaped, so a
// distinct one-shot source IP (the common case once the server is already
// configured: every unauthenticated caller 403s but still records a rate
// limit entry before the CreateOwnerIfEmpty check rejects them) leaves a
// windows[] entry that lives forever. Unlike a repeat caller, whose entry
// self-prunes on its next Allow() call, a one-shot caller never revisits its
// key, so only a periodic sweep (RateLimiter.Cleanup) can ever evict it.
func TestSetupLimiter_ReapsStaleEntries(t *testing.T) {
	restoreTiming := admin.SetSetupLimiterReapTiming(5*time.Millisecond, 5*time.Millisecond)
	defer restoreTiming()

	var limiter *auth.RateLimiter
	restoreHook := admin.CaptureSetupLimiter(func(rl *auth.RateLimiter) { limiter = rl })
	defer restoreHook()

	database := openAdminTestDB(t)
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database))

	if limiter == nil {
		t.Fatal("setup limiter was not captured — CaptureSetupLimiter hook not wired into NewAdminAPI")
	}

	// Simulate 20 distinct source IPs each making one POST /setup request —
	// each leaves its own windows[] entry that nothing but a reap can evict.
	const n = 20
	for i := range n {
		req := httptest.NewRequest(http.MethodPost, "/setup", strings.NewReader(`{}`))
		req.RemoteAddr = fmt.Sprintf("203.0.113.%d:1234", i)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
	}

	if wins, _ := limiter.Len(); wins != n {
		t.Fatalf("Len().windows = %d immediately after %d one-shot requests, want %d", wins, n, n)
	}

	// Wait well past the (shrunk) reap interval + max window for the sweep
	// to evict every now-stale entry.
	deadline := time.Now().Add(2 * time.Second)
	for {
		wins, _ := limiter.Len()
		if wins == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Len().windows = %d after waiting past the reap interval, want 0 — setupLimiter is never reaped (OC-0076)", wins)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
