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

// failingWriteLockoutStore fails every write, simulating a transient DB
// failure once the limiter is already running (audit-2026-08-19 F-3 — the
// write-path twin of OC-0061's load-path store).
type failingWriteLockoutStore struct{}

func (failingWriteLockoutStore) UpsertLockout(context.Context, string, time.Time) error {
	return errors.New("upsert: disk I/O error")
}
func (failingWriteLockoutStore) DeleteLockout(context.Context, string) error {
	return errors.New("delete: disk I/O error")
}
func (failingWriteLockoutStore) CleanupExpiredLockouts(context.Context) error {
	return errors.New("cleanup: disk I/O error")
}
func (failingWriteLockoutStore) LoadActiveLockouts(context.Context) ([]string, []time.Time, error) {
	return nil, nil, nil
}

// TestLockout_PersistErrorIsLoggedAndInMemoryLockoutHolds pins F-3's
// contract: a failed persist write is logged, and the in-memory lockout
// still applies for the life of the process.
func TestLockout_PersistErrorIsLoggedAndInMemoryLockoutHolds(t *testing.T) {
	rl := auth.NewPersistentRateLimiter(failingWriteLockoutStore{})

	out := captureLogs(t, func() {
		rl.Lockout(context.Background(), "login:198.51.100.7", time.Minute)
	})

	if !strings.Contains(out, "upsert: disk I/O error") {
		t.Errorf("expected log output to mention the persist error, got: %q", out)
	}
	if !rl.IsLockedOut("login:198.51.100.7") {
		t.Error("in-memory lockout must hold even when the persist write fails")
	}
}

// TestReset_DeleteErrorIsLoggedAndInMemoryStateClears pins the same
// contract on the delete path: the in-memory clear wins, the store failure
// is visible.
func TestReset_DeleteErrorIsLoggedAndInMemoryStateClears(t *testing.T) {
	rl := auth.NewPersistentRateLimiter(failingWriteLockoutStore{})
	rl.Lockout(context.Background(), "login:198.51.100.7", time.Minute)

	out := captureLogs(t, func() {
		rl.Reset(context.Background(), "login:198.51.100.7")
	})

	if !strings.Contains(out, "delete: disk I/O error") {
		t.Errorf("expected log output to mention the delete error, got: %q", out)
	}
	if rl.IsLockedOut("login:198.51.100.7") {
		t.Error("in-memory lockout must clear even when the store delete fails")
	}
}

// TestCleanup_StoreErrorIsLogged pins the third write path: the periodic
// expired-lockout cleanup logging its store failure instead of dropping it.
func TestCleanup_StoreErrorIsLogged(t *testing.T) {
	rl := auth.NewPersistentRateLimiter(failingWriteLockoutStore{})

	out := captureLogs(t, func() {
		rl.Cleanup(time.Minute)
	})

	if !strings.Contains(out, "cleanup: disk I/O error") {
		t.Errorf("expected log output to mention the cleanup error, got: %q", out)
	}
}
