package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"testing"
)

// The composite-close contract, as three properties. Before B3-3's rewrite
// there was no close function at all: teardown was a LIFO `defer` stack
// inside run(), so "reverse of start" was an emergent property of where each
// `defer` happened to be registered, nothing returned a teardown error but
// the one HTTP shutdown, and a stage that returned early simply skipped
// whatever it had not reached yet. These pin the replacement.

// TestAppClose_StopsInReverseOfStartOrder pins the ordering half of the
// contract: closers are appended in START order and Close walks them
// backwards, so the last stage to come up is the first to go down. Three
// facts in docs/architecture/server-boundaries.md depend on exactly this —
// the audit writer and the event persister must both stop before
// database.Close, and they are started after it.
func TestAppClose_StopsInReverseOfStartOrder(t *testing.T) {
	var order []string
	a := newTestApp()
	for _, name := range []string{"database", "telemetry", "router", "audit-writer", "http"} {
		a.onClose(name, func(context.Context) error {
			order = append(order, name)
			return nil
		})
	}

	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("Close() = %v, want nil when no closer fails", err)
	}

	want := []string{"http", "audit-writer", "router", "telemetry", "database"}
	if !slices.Equal(order, want) {
		t.Errorf("close order = %v, want %v (the reverse of the start order)", order, want)
	}
}

// TestAppClose_ReturnsFirstErrorAndStillRunsEveryLaterClose pins the error
// half: a failing stop must not abort the walk. The database handle, the
// LiveKit process and the audit queue are all closed by steps that run
// AFTER the HTTP shutdown, which is the one step that could realistically
// fail — so "return early on the first error" would leak exactly the
// resources teardown exists to release.
func TestAppClose_ReturnsFirstErrorAndStillRunsEveryLaterClose(t *testing.T) {
	errHTTP := errors.New("graceful shutdown: context deadline exceeded")
	errDatabase := errors.New("closing the database")

	var ran []string
	a := newTestApp()
	a.onClose("database", func(context.Context) error {
		ran = append(ran, "database")
		return errDatabase
	})
	a.onClose("router", func(context.Context) error {
		ran = append(ran, "router")
		return nil
	})
	a.onClose("http", func(context.Context) error {
		ran = append(ran, "http")
		return errHTTP
	})

	err := a.Close(context.Background())

	if !errors.Is(err, errHTTP) {
		t.Errorf("Close() = %v, want the FIRST error in close order (%v)", err, errHTTP)
	}
	if errors.Is(err, errDatabase) {
		t.Errorf("Close() = %v, want the first error only, not the last one", err)
	}
	want := []string{"http", "router", "database"}
	if !slices.Equal(ran, want) {
		t.Errorf("closers run = %v, want %v — a failing stop must not skip the ones below it", ran, want)
	}
}

// TestAppClose_IsIdempotent pins that a second Close does nothing: Run
// closes on every return path, and main() must be able to call it again (or
// a test through t.Cleanup) without double-stopping a hub or double-closing
// a database handle.
func TestAppClose_IsIdempotent(t *testing.T) {
	calls := 0
	a := newTestApp()
	a.onClose("database", func(context.Context) error {
		calls++
		return nil
	})

	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("first Close() = %v, want nil", err)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("second Close() = %v, want nil", err)
	}
	if calls != 1 {
		t.Errorf("closer ran %d times, want exactly 1", calls)
	}
}

// newTestApp is an App with only what Close needs: the logger it reports
// through. The stages are supplied by each test.
func newTestApp() *App {
	return &App{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}
