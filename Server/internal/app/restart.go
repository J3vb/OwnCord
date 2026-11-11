// Restart coordination for self-restarts (update apply, backup restore, setup
// wizard). The admin package never stops or spawns processes; it requests a
// restart through admin.SetRestartHandoff, which cancels Run's signal context
// so the process drains like a SIGTERM (including on Windows). main() hands off only after Run fully tore
// down (DB closed and its lock released); the bind retries are nets.

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
	// handoff; legitimate teardown is capped at 50s. Even this path joins managed LiveKit first, rather than
	// launch a server over ports it still owns.
	RestartBackstopDelay = 90 * time.Second
)

// RestartCoordinator owns one restart request; main() creates it, passes it to
// Run, and consults it again after Run returns.
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
// Run's signal context. onBackstop runs once if a requested restart's drain
// exceeds backstopDelay.
func NewRestartCoordinator(backstopDelay time.Duration, onBackstop func()) *RestartCoordinator {
	ctx, cancel := context.WithCancel(context.Background())
	return &RestartCoordinator{
		ctx:           ctx,
		cancel:        cancel,
		backstopDelay: backstopDelay,
		onBackstop:    onBackstop,
	}
}

// Context is the parent for Run's signal handling; a Request before Run reaches
// NotifyContext is safe, since an already-cancelled parent starts done.
func (rc *RestartCoordinator) Context() context.Context { return rc.ctx }

// SetMode records the resolved restart mode ("spawn"/"supervised"); Mode reads
// it back.
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
// reason wins.
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

// noticeReason is the intent the hub's restart notice tells clients, or a plain
// shutdown when the stop came from outside.
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

// Disarm stops the backstop timer; main() calls it when Run returns, since a
// delayed force-exit would only race its handoff.
func (rc *RestartCoordinator) Disarm() {
	rc.mu.Lock()
	if rc.backstop != nil {
		rc.backstop.Stop()
		rc.backstop = nil
	}
	rc.mu.Unlock()
}

// setCompanionStop registers the owned child independently of the ordered
// teardown, for the backstop when an earlier close step is stuck.
func (rc *RestartCoordinator) setCompanionStop(stop func()) {
	rc.mu.Lock()
	rc.stopCompanion = stop
	rc.mu.Unlock()
}

// PerformHandoff joins the managed companion and hands off exactly once;
// concurrent callers (main's return and the backstop) wait instead of spawning
// two replacement servers. When waited is true every caller must exit with exitCode.
func (rc *RestartCoordinator) PerformHandoff(log *slog.Logger) (exitCode int, waited bool) {
	return rc.handoff(log, false)
}

// PerformBackstopHandoff is PerformHandoff for a wedged teardown: this process
// never stays behind for its replacement.
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

func resolveRestartMode(cfgVal string, log *slog.Logger) string {
	mode, known := updater.ResolveRestartMode(cfgVal)
	if !known {
		log.Warn("unknown server.restart_mode, using auto detection",
			"value", cfgVal, "valid", "auto|spawn|supervised")
	}
	return mode
}

// spawnReplacement and spawnDetached are swappable in tests.
var (
	spawnReplacement = updater.SpawnReplacement
	spawnDetached    = updater.SpawnDetached
)

// PerformRestartHandoff completes a requested restart after Run has drained.
// Not when wedged: a stuck teardown may hold the listener or database lock,
// which only this process exiting releases.
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
