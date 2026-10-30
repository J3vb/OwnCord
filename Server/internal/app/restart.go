// Restart coordination for self-restarts (update apply, backup restore, setup
// wizard).
//
// The admin package never stops or spawns processes; it requests a restart
// through admin.SetRestartHandoff, which lands in RestartCoordinator.Request.
// Request cancels the parent context of Run's signal.NotifyContext, so the
// process drains through the same graceful path as a SIGTERM, including on
// Windows where a process cannot signal itself. Only after Run has fully torn
// down (listeners closed, hub and LiveKit stopped, queues flushed, database
// closed and its lock released) does main() perform the handoff: spawn the
// replacement binary when self-managed, or exit and let the supervisor
// relaunch. Releasing resources before the successor starts makes the handoff
// deterministic; the DB-lock and bind retries are only safety nets.

package app

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
)

const (
	restartModeSpawn      = updater.RestartModeSpawn
	restartModeSupervised = updater.RestartModeSupervised

	// RestartBackstopDelay sets when a stalled drain enters the emergency
	// handoff. Run's legitimate teardown is capped at 50s (teardownBudget), so
	// 90s only fires on a wedged teardown. Even this path must join the managed
	// LiveKit process before handing off, since exiting OwnCord alone need not
	// stop its child; a child the OS cannot reap keeps the handoff blocked
	// rather than launching another server over ports it still owns.
	RestartBackstopDelay = 90 * time.Second
)

// RestartCoordinator owns the lifecycle of one restart request. main() creates
// it, threads it into Run (so tests drive Run with their own), and consults it
// again after Run returns.
type RestartCoordinator struct {
	ctx    context.Context
	cancel context.CancelFunc

	backstopDelay time.Duration
	onBackstop    func()

	mu            syncutil.Mutex
	requested     bool
	reason        string
	mode          string
	backstop      *time.Timer
	stopCompanion func()
	handoffOnce   sync.Once
	exitCode      int
	waited        bool
}

// NewRestartCoordinator builds a coordinator whose Context() is the parent for
// Run's signal.NotifyContext. onBackstop runs once if a requested restart's
// drain exceeds backstopDelay; production passes handoff+os.Exit.
func NewRestartCoordinator(backstopDelay time.Duration, onBackstop func()) *RestartCoordinator {
	ctx, cancel := context.WithCancel(context.Background())
	return &RestartCoordinator{
		ctx:           ctx,
		cancel:        cancel,
		backstopDelay: backstopDelay,
		onBackstop:    onBackstop,
	}
}

// Context is the parent context for Run's signal handling: cancelling it
// (Request) is indistinguishable from a shutdown signal downstream. A Request
// before Run reaches NotifyContext is safe: an already-cancelled parent starts
// done and Run falls through to graceful teardown.
func (rc *RestartCoordinator) Context() context.Context { return rc.ctx }

// SetMode records the resolved restart mode ("spawn"/"supervised") once
// config is loaded; Mode reads it back for the handoff.
func (rc *RestartCoordinator) SetMode(mode string) {
	rc.mu.Lock()
	rc.mode = mode
	rc.mu.Unlock()
}

func (rc *RestartCoordinator) Mode() string {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.mode
}

// Request records a restart request and starts the drain. Idempotent: the first
// reason wins, duplicates are logged and dropped. It arms the backstop timer
// before cancelling so a wedged teardown cannot outlive it.
func (rc *RestartCoordinator) Request(reason string) {
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
func (rc *RestartCoordinator) Requested() (reason string, ok bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	return rc.reason, rc.requested
}

// noticeReason is what the hub's restart notice tells clients: the intent of a
// requested restart, or a plain shutdown when the stop came from outside (a
// signal, a supervisor). Admin handoff reasons lead with that intent
// ("update", "setup_wizard", ...), so the prefix is the mapping.
func (rc *RestartCoordinator) noticeReason() ws.RestartReason {
	reason, ok := rc.Requested()
	if !ok {
		return ws.RestartReasonShutdown
	}
	for _, intent := range []ws.RestartReason{ws.RestartReasonUpdate, ws.RestartReasonSetup, ws.RestartReasonBackupRestore} {
		if strings.HasPrefix(reason, string(intent)) {
			return intent
		}
	}
	return ws.RestartReasonShutdown
}

// Disarm stops the backstop timer. main() calls it when Run returns: from
// there the handoff is main()'s and a delayed force-exit would only race it.
func (rc *RestartCoordinator) Disarm() {
	rc.mu.Lock()
	if rc.backstop != nil {
		rc.backstop.Stop()
		rc.backstop = nil
	}
	rc.mu.Unlock()
}

// setCompanionStop registers the owned child independently of the ordered
// teardown. The backstop needs it when an earlier close step is stuck.
func (rc *RestartCoordinator) setCompanionStop(stop func()) {
	rc.mu.Lock()
	rc.stopCompanion = stop
	rc.mu.Unlock()
}

// PerformHandoff joins the managed companion and hands off exactly once. main's
// normal return and the restart backstop (PerformBackstopHandoff) share the
// same handoff, since stopping a timer cannot recall a callback that already
// started; concurrent callers wait for it instead of spawning two replacement
// servers. When waited is true every caller must exit with exitCode (see
// PerformRestartHandoff).
func (rc *RestartCoordinator) PerformHandoff(log *slog.Logger) (exitCode int, waited bool) {
	return rc.handoff(log, false)
}

// PerformBackstopHandoff is PerformHandoff for the restart backstop: the
// teardown is wedged, so this process never stays behind for its replacement.
func (rc *RestartCoordinator) PerformBackstopHandoff(log *slog.Logger) (exitCode int, waited bool) {
	return rc.handoff(log, true)
}

func (rc *RestartCoordinator) handoff(log *slog.Logger, wedged bool) (exitCode int, waited bool) {
	reason, requested := rc.Requested()
	if !requested {
		return 0, false
	}
	rc.handoffOnce.Do(func() {
		rc.Disarm()
		rc.mu.Lock()
		stop, mode := rc.stopCompanion, rc.mode
		rc.mu.Unlock()
		if stop != nil {
			stop()
		}
		rc.exitCode, rc.waited = PerformRestartHandoff(reason, mode, wedged, log)
	})
	return rc.exitCode, rc.waited
}

// resolveRestartMode turns cfg.Server.RestartMode into the effective handoff
// mode (updater.ResolveRestartMode), warning on a value it does not know.
func resolveRestartMode(cfgVal string, log *slog.Logger) string {
	mode, known := updater.ResolveRestartMode(cfgVal)
	if !known {
		log.Warn("unknown server.restart_mode, using auto detection",
			"value", cfgVal, "valid", "auto|spawn|supervised")
	}
	return mode
}

// spawnReplacement and spawnDetached are the replacement-process spawners,
// swappable in tests (which must not start real processes).
var (
	spawnReplacement = updater.SpawnReplacement
	spawnDetached    = updater.SpawnDetached
)

// PerformRestartHandoff completes a requested restart after Run has fully
// drained. In supervised mode the handoff is the exit: the supervisor (systemd
// Restart=, NSSM AppExit, Docker restart policy) relaunches the service. In
// spawn mode the replacement is started directly, with every resource already
// released. A failed spawn leaves the server down, loudly logged; no hub is
// left to notify clients through.
//
// A Windows server on a console stays behind until its replacement exits (see
// updater.SpawnReplacement): waited is then true and exitCode is the
// replacement's. Not when wedged: a teardown that never finished may still
// hold the listener or database lock, which only this process exiting releases.
func PerformRestartHandoff(reason, mode string, wedged bool, log *slog.Logger) (exitCode int, waited bool) {
	if mode == restartModeSupervised {
		log.Info("restart: exiting for the supervisor to relaunch", "reason", reason, "mode", mode)
		return 0, false
	}
	exePath, err := updater.ExecutablePath()
	if err != nil {
		log.Error("restart: cannot determine executable path — manual restart required",
			"reason", reason, "error", err)
		return 0, false
	}
	var wait func() int
	if wedged {
		log.Warn("restart: teardown is wedged, so this process exits to release what it still holds "+
			"instead of staying behind; on a Windows console the replacement opens in a new console window",
			"reason", reason)
		err = spawnDetached(exePath, os.Args[1:])
	} else {
		wait, err = spawnReplacement(exePath, os.Args[1:])
	}
	if err != nil {
		log.Error("restart: spawning the replacement process FAILED — manual restart required",
			"reason", reason, "error", err)
		return 0, false
	}
	log.Info("restart: replacement process spawned", "reason", reason, "path", exePath)
	if wait == nil {
		return 0, false
	}
	log.Info("restart: staying behind on this console until the replacement exits")
	return wait(), true
}
