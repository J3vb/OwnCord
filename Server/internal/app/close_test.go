package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
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

// fakeDispatchHub is a hub whose dispatch loop exits only when the test
// says so: stopped closes when GracefulStopContext is called, and done is
// the loop's own exit.
type fakeDispatchHub struct {
	stopped chan struct{}
	done    chan struct{}
}

func (h *fakeDispatchHub) GracefulStopContext(context.Context) { close(h.stopped) }
func (h *fakeDispatchHub) Done() <-chan struct{}               { return h.done }

// TestStopHub_WaitsForTheDispatchLoopToExit pins the join the hub close step
// adds after GracefulStopContext. That call only signals the loop; without
// the join Run could return with dispatch still alive, which is what the
// event-persistence row of the stage-failure test caught intermittently.
func TestStopHub_WaitsForTheDispatchLoopToExit(t *testing.T) {
	hub := &fakeDispatchHub{stopped: make(chan struct{}), done: make(chan struct{})}
	returned := make(chan error, 1)
	go func() { returned <- stopHub(context.Background(), hub) }()

	<-hub.stopped
	select {
	case err := <-returned:
		t.Fatalf("stopHub returned (%v) while the dispatch loop was still running", err)
	case <-time.After(100 * time.Millisecond):
	}

	close(hub.done)
	select {
	case err := <-returned:
		if err != nil {
			t.Fatalf("stopHub() = %v, want nil once the loop exited", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stopHub did not return after the dispatch loop exited")
	}
}

// TestStopHub_BoundedByTheShutdownBudget pins that the join cannot wedge
// Close: a loop that never exits costs the step its budget, reported as an
// error, and the walk goes on to the steps below it.
func TestStopHub_BoundedByTheShutdownBudget(t *testing.T) {
	hub := &fakeDispatchHub{stopped: make(chan struct{}), done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	err := stopHub(ctx, hub)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("stopHub() = %v, want it to report the expired budget", err)
	}
}

// newTestApp is an App with only what Close needs: the logger it reports
// through. The stages are supplied by each test.
func newTestApp() *App {
	return &App{log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestAppClose_GivesEveryStepItsOwnBudget is SRV-06: the steps used to share
// one deadline, so an HTTP drain that overran it left the hub's restart
// notice, the audit drain and the event flush running on an expired context.
// A step that uses up its budget must leave the next step a live one, and
// every step's duration is logged.
func TestAppClose_GivesEveryStepItsOwnBudget(t *testing.T) {
	var logs bytes.Buffer
	a := &App{log: slog.New(slog.NewTextHandler(&logs, nil)), closeStepBudget: 50 * time.Millisecond}
	auditCtxErr := errors.New("audit-writer step never ran")
	a.onClose("audit-writer", func(ctx context.Context) error {
		auditCtxErr = ctx.Err()
		return nil
	})
	a.onClose("http", func(ctx context.Context) error {
		<-ctx.Done() // an open stream holding the drain for the whole budget
		return ctx.Err()
	})

	caller, cancel := context.WithCancel(context.Background())
	cancel() // the caller's cancellation must not cut teardown short either
	if err := a.Close(caller); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() = %v, want the http step's own deadline", err)
	}
	if auditCtxErr != nil {
		t.Errorf("audit-writer step ran on a dead context (%v): it inherited the http step's overrun", auditCtxErr)
	}
	for _, stage := range []string{"stage=http duration=", "stage=audit-writer duration="} {
		if !strings.Contains(logs.String(), stage) {
			t.Errorf("no duration logged for %s; log:\n%s", stage, logs.String())
		}
	}
}

// TestAppClose_HTTPDrainKeepsItsLongerBudget: the http step startHTTP
// registers gets httpDrainBudget, matching the server's read and write
// timeouts, so a slow request the server allows is not cut off at the 10s
// every other step gets.
func TestAppClose_HTTPDrainKeepsItsLongerBudget(t *testing.T) {
	a := newTestApp()
	a.cfg = &config.Config{}
	if err := a.startHTTP(); err != nil {
		t.Fatalf("startHTTP() = %v", err)
	}
	t.Cleanup(func() { _ = a.ln.Close() })

	remaining := map[string]time.Duration{}
	for i := range a.closers {
		stage := a.closers[i].stage
		a.closers[i].stop = func(ctx context.Context) error {
			deadline, ok := ctx.Deadline()
			if !ok {
				t.Errorf("%s step ran without a deadline", stage)
			}
			remaining[stage] = time.Until(deadline)
			return nil
		}
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("Close() = %v", err)
	}
	within := func(stage string, budget time.Duration) {
		if got := remaining[stage]; got > budget || got < budget-5*time.Second {
			t.Errorf("%s step budget = %v, want %v", stage, got, budget)
		}
	}
	within("http", 30*time.Second)
	within("hub-notice", 10*time.Second)
	within("listener", 10*time.Second)
}

// TestAppClose_OverallDeadlineCapsTheSteps: the step budgets add up (a 30s
// drain plus 10s for each later step), so one overall deadline caps the walk
// to keep a teardown inside systemd's stop timeout. Every step still runs.
func TestAppClose_OverallDeadlineCapsTheSteps(t *testing.T) {
	a := newTestApp()
	a.closeStepBudget = 200 * time.Millisecond
	a.teardownBudget = 300 * time.Millisecond
	var ran []string
	for _, stage := range []string{"database", "audit-writer", "http"} {
		a.onClose(stage, func(ctx context.Context) error {
			ran = append(ran, stage)
			<-ctx.Done()
			return ctx.Err()
		})
	}

	started := time.Now()
	if err := a.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Close() = %v, want a deadline error", err)
	}
	if took := time.Since(started); took >= 500*time.Millisecond {
		t.Errorf("Close took %v; the 300ms overall deadline should cap the 600ms of step budgets", took)
	}
	if want := []string{"http", "audit-writer", "database"}; !slices.Equal(ran, want) {
		t.Errorf("steps run = %v, want %v", ran, want)
	}
}
