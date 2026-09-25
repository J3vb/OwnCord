package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.uber.org/goleak"
)

// The lifecycle failure-injection report the B3 exit gate asks for (plan
// §B3-3 item 3). Every stage App.start brings up is made to fail in turn and
// the same four properties are asserted each time:
//
//	1. the returned error names the stage that failed;
//	2. no goroutine is left running (goleak) — the hub's dispatch goroutine,
//	   the event pruner, the maintenance loop and the ACME listener are all
//	   started by stages that may already have run;
//	3. the database handle is closed, so the SQLite process lock is released
//	   for the successor a restart handoff is about to start;
//	4. the listener is not left bound, so that successor can take the port.
//
// The table is generated from App.stages() rather than written out, so a new
// stage is covered the day it is added instead of the day someone remembers
// to add a row.
//
// Before B3-3 there was no single teardown to test: run() unwound through a
// LIFO defer stack, and an early return simply skipped whatever it had not
// reached. TestAppClose_* in close_test.go pins the ordering and error
// contract of the walk; this pins what the walk actually releases.

// freePort returns a port nothing is listening on. The tiny window in which
// something else could take it is absorbed by the server's own bind retry.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

// assertPortFree fails when anything is still listening on port — the
// "listener is not left bound" assertion.
func assertPortFree(t *testing.T, port int) {
	t.Helper()
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Errorf("port %d is still bound after Run returned: %v", port, err)
		return
	}
	_ = l.Close()
}

// assertReleased is properties 2-4: nothing running, nothing open, nothing
// bound. leakOpt must have been taken before the App was booted.
func assertReleased(t *testing.T, a *App, port int, leakOpt goleak.Option) {
	t.Helper()
	if a.database != nil {
		if err := a.database.PingRead(context.Background()); err == nil {
			t.Error("the database handle is still open after Run returned — the SQLite process lock is not released")
		}
	}
	if a.hub != nil && a.hub.DispatchAlive() {
		t.Error("hub dispatch is still alive after Run returned — GracefulStop was skipped, so a supervised LiveKit process would be orphaned")
	}
	assertPortFree(t, port)
	if err := goleak.Find(leakOpt); err != nil {
		t.Errorf("goroutine leaked after Run returned: %v", err)
	}
}

// TestAppRun_StartFailure_KeepsOldBinary is REL-01: the previous binary's
// cleanup must not run until every start stage has succeeded, so a migration
// (or other start) failure leaves the documented rollback copy in place.
// removeOldBinary used to run as the first act of start(), before any stage
// could prove the new binary bootable.
func TestAppRun_StartFailure_KeepsOldBinary(t *testing.T) {
	var cleanupRan bool
	prev := removeOldBinaryFn
	removeOldBinaryFn = func(*slog.Logger) { cleanupRan = true }
	t.Cleanup(func() { removeOldBinaryFn = prev })

	a := bootTestApp(t, "0", "migrate")
	if err := a.Run(context.Background()); err == nil {
		t.Fatal("Run() = nil, want the injected migrate failure")
	}
	if cleanupRan {
		t.Error("old-binary cleanup ran despite a start-stage failure: the rollback copy is gone (REL-01)")
	}
}

// TestAppRun_Success_RemovesOldBinaryAfterStages is the positive control for
// the test above: on a successful start the cleanup does run.
func TestAppRun_Success_RemovesOldBinaryAfterStages(t *testing.T) {
	var cleanupRan bool
	prev := removeOldBinaryFn
	removeOldBinaryFn = func(*slog.Logger) { cleanupRan = true }
	t.Cleanup(func() { removeOldBinaryFn = prev })

	a := bootTestApp(t, "0", "")
	// Cancel immediately: Run serves until the context is done and then
	// returns cleanly, which is enough to reach the post-stage cleanup.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := a.Run(ctx); err != nil {
		t.Fatalf("Run() = %v, want a clean shutdown", err)
	}
	if !cleanupRan {
		t.Error("old-binary cleanup did not run on a successful start")
	}
}

// TestAppRun_PortInUse_KeepsOldBinary is REL-01 for the listener: a port
// another process holds must fail start-up before the rollback copy is
// removed. The bind used to happen asynchronously in serve(), after the
// cleanup had already run.
func TestAppRun_PortInUse_KeepsOldBinary(t *testing.T) {
	var cleanupRan bool
	prev := removeOldBinaryFn
	removeOldBinaryFn = func(*slog.Logger) { cleanupRan = true }
	t.Cleanup(func() { removeOldBinaryFn = prev })
	prevEvery := bindRetryEvery
	bindRetryEvery = time.Millisecond
	t.Cleanup(func() { bindRetryEvery = prevEvery })

	held, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("hold port: %v", err)
	}
	defer held.Close() //nolint:errcheck
	port := held.Addr().(*net.TCPAddr).Port

	a := bootTestApp(t, fmt.Sprint(port), "")
	if err := a.Run(context.Background()); err == nil {
		t.Fatal("Run() = nil, want a bind failure on a held port")
	}
	if cleanupRan {
		t.Error("old-binary cleanup ran despite the listener failing to bind: the rollback copy is gone (REL-01)")
	}
}

func TestAppRun_EveryStageFailure_ReleasesEverythingItStarted(t *testing.T) {
	for _, name := range stageNames() {
		t.Run(name, func(t *testing.T) {
			port := freePort(t)
			leakOpt := goleak.IgnoreCurrent()
			a := bootTestApp(t, fmt.Sprint(port), name)

			err := a.Run(context.Background())
			if err == nil {
				t.Fatalf("Run() = nil, want the injected %s failure", name)
			}
			if !errors.Is(err, errStageInjected) {
				t.Errorf("Run() = %v, want it to wrap the injected failure", err)
			}
			if !strings.Contains(err.Error(), name) {
				t.Errorf("Run() = %v, want an error naming the stage that failed (%s)", err, name)
			}
			assertReleased(t, a, port, leakOpt)
		})
	}
}

// stageNames is the start sequence by name, read off a throwaway App so the
// table above cannot drift from the real list.
func stageNames() []string {
	stages := (&App{}).stages()
	names := make([]string, 0, len(stages))
	for _, st := range stages {
		names = append(names, st.name)
	}
	return names
}

// TestAppRun_ListenerBindFailure_ReleasesEverythingItStarted is the same
// four properties for a real failure rather than an injected one: every
// stage up to http starts, and the listener itself refuses to bind. An
// out-of-range port fails the first attempt with an error isAddrInUse does
// not recognise, so the http stage fails immediately instead of retrying for
// ~10s. This is the path OC-0027 was about.
func TestAppRun_ListenerBindFailure_ReleasesEverythingItStarted(t *testing.T) {
	leakOpt := goleak.IgnoreCurrent()
	a := bootTestApp(t, "99999", "")

	err := a.Run(context.Background())
	if err == nil {
		t.Fatal("Run() = nil, want a listener error for an out-of-range port")
	}
	if !strings.Contains(err.Error(), "starting http") {
		t.Errorf("Run() = %v, want the http stage's bind error", err)
	}
	if a.hub == nil {
		t.Fatal("the hub stage runs before the listener binds, so the hub must have been built")
	}
	// Port 99999 was never bindable, so only the release assertions apply.
	if pingErr := a.database.PingRead(context.Background()); pingErr == nil {
		t.Error("the database handle is still open after Run returned")
	}
	if a.hub.DispatchAlive() {
		t.Error("hub dispatch is still alive after Run returned")
	}
	if leakErr := goleak.Find(leakOpt); leakErr != nil {
		t.Errorf("goroutine leaked after a listener failure: %v", leakErr)
	}
}

// waitForHealth blocks until the server answers /health on port, failing the
// test if Run exits first or the server never comes up.
func waitForHealth(t *testing.T, port int, runErr <-chan error) {
	t.Helper()
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	// Startup migrates a fresh DB; under -race on a loaded Windows CI runner that
	// alone has taken 15s, so the deadline leaves generous headroom.
	for deadline := time.Now().Add(60 * time.Second); time.Now().Before(deadline); {
		resp, healthErr := http.Get(healthURL) //nolint:gosec // G107: loopback URL built from the test's own port
		if healthErr == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			return
		}
		select {
		case err := <-runErr:
			t.Fatalf("Run exited before serving: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	t.Fatal("server never became reachable on /health")
}

// TestAppRun_ContextCancel_DrainsAndReleases is the control the injected rows
// need: the same four properties on the path where nothing fails at all. Run
// serves for real, the caller's context is cancelled (the same cancellation a
// SIGTERM or a restart request delivers), and the composite close still
// releases the handle, the hub and the port — with a nil error, so the
// assertions above are not passing merely because something went wrong.
func TestAppRun_ContextCancel_DrainsAndReleases(t *testing.T) {
	port := freePort(t)
	leakOpt := goleak.IgnoreCurrent()
	a := bootTestApp(t, fmt.Sprint(port), "")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()

	waitForHealth(t, port, runErr)

	cancel()
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run() after the context was cancelled = %v, want nil (clean drain)", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	assertReleased(t, a, port, leakOpt)
}

// TestAppRun_CallerCancel_KeepsBackgroundWorkersAliveThroughTheDrain pins the
// one thing the HTTP-first close order exists for: when Close drains
// in-flight HTTP handlers, the consumers their work feeds — the event
// persister, the audit writer and the maintenance loop, all running under
// bgCtx — must still be alive, or those handlers' broadcasts never reach the
// replay/event store and their audit records are dropped.
//
// run() got this for free by rooting bgCtx at context.Background(): only
// bgCancel ever ended it, and the ordered teardown called that last. Deriving
// bgCtx from Run's own ctx instead would cancel all three the instant a
// caller cancelled — before the drain — and would make caller-context
// shutdown behave differently from the SIGTERM and restart paths, which
// cancel only the serve context. So bgCtx inherits ctx's values but not its
// cancellation, and this asserts that at the exact point it matters.
func TestAppRun_CallerCancel_KeepsBackgroundWorkersAliveThroughTheDrain(t *testing.T) {
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")

	// Record what bgCtx looked like as each close step was about to run.
	bgErrAt := map[string]error{}
	a.onCloseStep = func(stage string) { bgErrAt[stage] = a.bgCtx.Err() }

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	runErr := make(chan error, 1)
	go func() { runErr <- a.Run(ctx) }()
	waitForHealth(t, port, runErr)

	cancel()
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run() after the context was cancelled = %v, want nil (clean drain)", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}

	// The steps that must find bgCtx still live, in the order Close runs them.
	for _, stage := range []string{"signals", "http", "maintenance", "audit-writer"} {
		if err, ran := bgErrAt[stage]; !ran {
			t.Errorf("the %q close step never ran", stage)
		} else if err != nil {
			t.Errorf("bgCtx was already cancelled (%v) when the %q close step ran — the event persister, audit writer and maintenance loop had exited before the HTTP drain, so an in-flight handler's broadcasts and audit records are dropped", err, stage)
		}
	}
	// event-persistence is the step that cancels bgCtx and joins the pruner,
	// so from there down it is expected to be done.
	if err, ran := bgErrAt["database"]; !ran {
		t.Error(`the "database" close step never ran`)
	} else if err == nil {
		t.Error("bgCtx was still live when the database closed — the event pruner and maintenance loop had not been joined, so a query could still be in flight against a closing pool")
	}
}
