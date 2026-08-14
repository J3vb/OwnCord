package auth_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/owncord/server/auth"
)

// failingLockoutStore reports an error from LoadActiveLockouts, simulating a
// transient DB failure (SQLITE_BUSY, disk I/O error) at startup.
type failingLockoutStore struct{}

func (failingLockoutStore) UpsertLockout(context.Context, string, time.Time) error { return nil }
func (failingLockoutStore) DeleteLockout(context.Context, string) error            { return nil }
func (failingLockoutStore) CleanupExpiredLockouts(context.Context) error           { return nil }
func (failingLockoutStore) LoadActiveLockouts(context.Context) ([]string, []time.Time, error) {
	return nil, nil, errors.New("database is locked")
}

// captureLogs redirects the default slog logger to a buffer for the duration
// of fn and returns everything it wrote. Mirrors db/audit_test.go's helper.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	return buf.String()
}

// TestNewPersistentRateLimiter_LoadErrorIsLogged pins OC-0061: a failed
// LoadActiveLockouts must not be swallowed silently — it has to produce a log
// line so an operator can notice that persisted lockouts were dropped.
func TestNewPersistentRateLimiter_LoadErrorIsLogged(t *testing.T) {
	out := captureLogs(t, func() {
		auth.NewPersistentRateLimiter(failingLockoutStore{})
	})

	if !strings.Contains(out, "database is locked") {
		t.Errorf("expected log output to mention the load error, got: %q", out)
	}
}
