// Restart coordination for self-restarts (update apply, backup restore,
// setup wizard).
//
// The admin package never stops or spawns processes; it requests a restart
// through admin.SetRestartHandoff, which lands in restartCoordinator.Request
// here. Request cancels the parent context of run()'s signal.NotifyContext,
// so the process drains through the exact same graceful path a SIGTERM takes
// — including on Windows, where a process cannot deliver a signal to itself.
// Only after run() has fully torn down (HTTP listeners closed, hub and
// LiveKit stopped, queues flushed, database closed and its process lock
// released) does main() perform the handoff: spawn the replacement binary
// when self-managed, or just exit and let the process supervisor relaunch
// the service. The old process being completely gone before the successor
// starts is what makes the handoff deterministic — the DB-lock and bind
// retries in db/ and main.go survive only as safety nets.
package main

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/updater"
)

const (
	restartModeSpawn      = "spawn"
	restartModeSupervised = "supervised"

	// restartBackstopDelay bounds how long a requested restart may drain
	// before the process force-exits (performing the handoff first). run()'s
	// worst-case legitimate teardown is ≈55s — the 30s shutdown budget plus
	// its sequential bounded defers — so 90s only ever fires on a genuinely
	// wedged teardown. The successor's lock/bind retries absorb whatever a
	// backstop exit leaves unreleased.
	restartBackstopDelay = 90 * time.Second
)

// restartCoordinator owns the lifecycle of one restart request. It is
// created in main(), threaded into run() (as a parameter, so tests drive
// run() with their own instance), and consulted by main() again after run()
// returns.
type restartCoordinator struct {
	ctx    context.Context
	cancel context.CancelFunc

	backstopDelay time.Duration
	onBackstop    func()

	mu        syncutil.Mutex
	requested bool
	reason    string
	mode      string
	backstop  *time.Timer
}

// newRestartCoordinator builds a coordinator whose Context() is the parent
// for run()'s signal.NotifyContext. onBackstop runs once if a requested
// restart's drain exceeds backstopDelay; production passes handoff+os.Exit,
// tests pass a recorder.
func newRestartCoordinator(backstopDelay time.Duration, onBackstop func()) *restartCoordinator {
	ctx, cancel := context.WithCancel(context.Background())
	return &restartCoordinator{
		ctx:           ctx,
		cancel:        cancel,
		backstopDelay: backstopDelay,
		onBackstop:    onBackstop,
	}
}

// Context is the parent context for run()'s signal handling: cancelling it
// (Request) is indistinguishable from a shutdown signal to everything
// downstream. A Request issued before run() reaches NotifyContext is safe —
// NotifyContext over an already-cancelled parent starts out done, and run()
// falls straight through to graceful teardown.
func (rc *restartCoordinator) Context() context.Context { return rc.ctx }

// SetMode records the resolved restart mode ("spawn"/"supervised") once
// config is loaded; Mode reads it back for the handoff.
func (rc *restartCoordinator) SetMode(mode string) {
	rc.mu.Lock()
	rc.mode = mode
	rc.mu.Unlock()
}

func (rc *restartCoordinator) Mode() string {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.mode
}

// Request records a restart request and starts the drain. Idempotent: the
// first reason wins, duplicates are logged and dropped. Arms the backstop
// timer before cancelling so a wedged teardown can never outlive it.
func (rc *restartCoordinator) Request(reason string) {
	rc.mu.Lock()
	if rc.requested {
		pending := rc.reason
		rc.mu.Unlock()
		slog.Info("restart already pending — duplicate request dropped",
			"reason", reason, "pending_reason", pending)
		return
	}
	rc.requested = true
	rc.reason = reason
	mode := rc.mode
	if rc.onBackstop != nil {
		rc.backstop = time.AfterFunc(rc.backstopDelay, rc.onBackstop)
	}
	rc.mu.Unlock()

	slog.Info("restart requested — draining for handoff", "reason", reason, "mode", mode)
	rc.cancel()
}

// Requested reports whether a restart was requested, and its reason.
func (rc *restartCoordinator) Requested() (reason string, ok bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.reason, rc.requested
}

// disarm stops the backstop timer. main() calls it the moment run() returns:
// from there the handoff is in main()'s hands and a delayed force-exit would
// only race it.
func (rc *restartCoordinator) disarm() {
	rc.mu.Lock()
	if rc.backstop != nil {
		rc.backstop.Stop()
		rc.backstop = nil
	}
	rc.mu.Unlock()
}

// resolveRestartMode turns cfg.Server.RestartMode into the effective handoff
// mode. Explicit "spawn"/"supervised" win; "auto" (or empty, or an unknown
// value after a warning) detects: containers and supervised services exit
// for their supervisor/engine to relaunch, everything else spawns its own
// replacement.
func resolveRestartMode(cfgVal string, log *slog.Logger) string {
	switch cfgVal {
	case restartModeSpawn, restartModeSupervised:
		return cfgVal
	case "", "auto":
	default:
		log.Warn("unknown server.restart_mode, using auto detection",
			"value", cfgVal, "valid", "auto|spawn|supervised")
	}
	if updater.RunningInContainer() || updater.RunningUnderSupervisor() {
		return restartModeSupervised
	}
	return restartModeSpawn
}

// spawnReplacement is the replacement-process spawner, swappable in tests
// (which must not start real processes).
var spawnReplacement = updater.SpawnDetached

// performRestartHandoff completes a requested restart after run() has fully
// drained. In supervised mode the handoff IS the exit — the supervisor
// (systemd Restart=, NSSM AppExit, Docker restart policy) relaunches the
// service, now running the swapped binary. In spawn mode the replacement is
// started directly; every resource is already released, so the successor
// boots with no lock or port contention. A failed spawn leaves the server
// down — loudly logged; there is no hub left to notify clients through.
func performRestartHandoff(reason, mode string, log *slog.Logger) {
	if mode == restartModeSupervised {
		log.Info("restart: exiting for the supervisor to relaunch", "reason", reason, "mode", mode)
		return
	}
	exePath, err := os.Executable()
	if err != nil {
		log.Error("restart: cannot determine executable path — manual restart required",
			"reason", reason, "error", err)
		return
	}
	if resolved, symErr := filepath.EvalSymlinks(exePath); symErr == nil {
		exePath = resolved
	}
	if err := spawnReplacement(exePath, os.Args[1:]); err != nil {
		log.Error("restart: spawning the replacement process FAILED — manual restart required",
			"reason", reason, "error", err)
		return
	}
	log.Info("restart: replacement process spawned", "reason", reason, "path", exePath)
}
