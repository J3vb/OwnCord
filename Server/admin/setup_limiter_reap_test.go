package admin_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
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
	// synctest's fake clock covers POST /setup's real one-minute window and
	// the five-minute sweep without waiting for either; the ten minutes below
	// assume the sweep interval stays at or under that.
	synctest.Test(t, func(t *testing.T) {
		var limiter *auth.RateLimiter
		restoreHook := admin.CaptureSetupLimiter(func(rl *auth.RateLimiter) { limiter = rl })
		defer restoreHook()

		database := openAdminTestDB(t)
		handler := admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, newTestServices(database))

		if limiter == nil {
			t.Fatal("setup limiter was not captured — CaptureSetupLimiter hook not wired into NewAdminAPI")
		}

		const n = 20
		for i := range n {
			req := httptest.NewRequest(http.MethodPost, "/setup", strings.NewReader(`{}`))
			req.RemoteAddr = fmt.Sprintf("203.0.113.%d:1234", i)
			handler.ServeHTTP(httptest.NewRecorder(), req)
		}
		if wins, _ := limiter.Len(); wins != n {
			t.Fatalf("Len().windows = %d immediately after %d one-shot requests, want %d", wins, n, n)
		}

		time.Sleep(10 * time.Minute)
		synctest.Wait()
		if wins, _ := limiter.Len(); wins != 0 {
			t.Fatalf("Len().windows = %d ten minutes on, want 0 — setupLimiter is never reaped (OC-0076)", wins)
		}
	})
}
