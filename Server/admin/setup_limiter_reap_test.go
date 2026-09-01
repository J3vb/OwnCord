package admin_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/auth"
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
	handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestModService(database), newTestRoleService(database), newTestSettingsService(database), newTestChannelService(database))

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

	// Wait for the sweep to evict every now-stale entry.
	//
	// The budget is a liveness bound, not a latency assertion, and it is
	// deliberately far larger than the 5ms timings above. The reaper is a
	// self-rescheduling time.AfterFunc chain, so this test can only observe it
	// once the runtime schedules that callback — and under a full
	// `go test ./...`, where every package's tests run at once, that can be
	// delayed by seconds while the reaper is working perfectly. A 2s deadline
	// used to sit here and did exactly what a wall-clock assertion about
	// somebody else's goroutine always does: it failed once under load and
	// reported "never reaped" for a reaper that had simply not run yet.
	//
	// Progress-tracking would not help: Cleanup evicts every entry older than
	// maxWindow in one pass, and all 20 were recorded together, so the count
	// goes 20 -> 0 in a single sweep with nothing in between to watch. The
	// property this test owns is that the sweep is WIRED — with no reaper the
	// count sits at n forever and this still fails, just later. A healthy run
	// returns in about one interval and pays none of the budget.
	const reapBudget = 30 * time.Second
	deadline := time.Now().Add(reapBudget)
	for {
		wins, _ := limiter.Len()
		if wins == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Len().windows = %d after %v, want 0 — setupLimiter is never reaped (OC-0076)", wins, reapBudget)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
