package db_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// fakeAuditor lets a test drive WriteAudit down either the success or the
// failure path without a real database.
type fakeAuditor struct {
	err    error
	called bool
}

func (f *fakeAuditor) LogAudit(_ context.Context, _ int64, _, _ string, _ int64, _ string) error {
	f.called = true
	return f.err
}

// captureLogs redirects the default slog logger to a buffer for the duration
// of fn and returns everything it wrote.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	defer slog.SetDefault(prev)
	fn()
	return buf.String()
}

func TestWriteAudit_LogsFailureButDoesNotPropagate(t *testing.T) {
	a := &fakeAuditor{err: errors.New("disk on fire")}

	// WriteAudit returns nothing, so "never propagated" is structural — the
	// call simply must not panic and must record the failure.
	out := captureLogs(t, func() {
		db.WriteAudit(context.Background(), a, 7, "user_ban", "user", 42, "spam")
	})

	if !a.called {
		t.Fatal("WriteAudit did not attempt the underlying LogAudit")
	}
	for _, want := range []string{
		"audit log write failed",
		"action=user_ban",
		"actor_id=7",
		"target_type=user",
		"target_id=42",
		"disk on fire",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("failure log missing %q; got: %s", want, out)
		}
	}
	// The detail string must not leak into logs.
	if strings.Contains(out, "spam") {
		t.Errorf("detail string leaked into audit failure log: %s", out)
	}
}

func TestWriteAudit_SuccessLogsNothing(t *testing.T) {
	a := &fakeAuditor{err: nil}

	out := captureLogs(t, func() {
		db.WriteAudit(context.Background(), a, 1, "user_login", "user", 1, "")
	})

	if !a.called {
		t.Fatal("WriteAudit did not attempt the underlying LogAudit")
	}
	if strings.Contains(out, "audit log write failed") {
		t.Errorf("successful audit write should not log a failure; got: %s", out)
	}
}
