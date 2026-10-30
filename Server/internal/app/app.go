package app

import (
	"context"
	"crypto/ecdh"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Deps are the pieces main() owns and hands in: the build version, the logger
// and ring buffer both log sinks are wired against, and the restart
// coordinator whose handoff main() performs after Run returns.
type Deps struct {
	Version string
	Log     *slog.Logger
	LogBuf  *admin.RingBuffer
	Restart *RestartCoordinator
	// LogLevelVar is the *slog.LevelVar main's log sinks read. app.New wraps it
	// in the admin API's log-level controller, with LogBaseLevel as the level a
	// timed debug boost reverts to. Nil in tests without main's wiring; the
	// endpoints then report 503.
	LogLevelVar  *slog.LevelVar
	LogBaseLevel slog.Level
}

// closeStep is one teardown step: the stage that registered it, how that stage
// stops, and its budget (zero means closeStepBudget). Steps are appended in
// start order and Close walks them backwards.
type closeStep struct {
	stage  string
	budget time.Duration
	stop   func(context.Context) error
}

// App is one server process. Each stage the lifecycle starts owns a field here
// and registers exactly one closeStep as it comes up, so there is a single
// teardown path for a failed start, a serve error and a clean shutdown.
type App struct {
	cfg  *config.Config
	deps Deps
	log  *slog.Logger

	// rootCtx is the context Run was given; every other context descends from
	// it, so cancelling it stops the server as a signal does.
	rootCtx context.Context
	// bgCtx is the context every background goroutine (event persister,
	// pruner, plugin loader, maintenance loop) runs under. bgCancel is the
	// first-registered closer so it runs last, as a backstop: the persistence
	// and maintenance steps cancel it and join their goroutines earlier.
	bgCtx    context.Context
	bgCancel context.CancelFunc

	tlsCfg      *tls.Config
	httpHandler http.Handler // ACME HTTP-01 handler; nil outside acme mode
	database    *db.DB
	plugins     *plugin.Registry
	runtime     api.Runtime
	hub         *ws.Hub
	router      http.Handler
	addr        string
	srv         *http.Server
	pprofSrv    *http.Server // opt-in loopback pprof listener; nil unless enabled
	ln          net.Listener
	acmeSrv     *http.Server
	persister   *ws.EventPersister
	prunerDone  <-chan struct{}
	auditWriter *db.AuditWriter
	// background owns the request-path jobs that outlive their request (Web
	// Push dispatch, the no-worker mention write); its close step joins or
	// abandons them before the database closes.
	background *syncutil.Group
	// shutdown is closed at the start of Close, before the first step, to tell
	// work that must not complete during a shutdown (the update apply tail's
	// countdown and binary swap) to stop. The background group is deliberately
	// not stopped early: handlers running during the HTTP drain keep spawning
	// jobs.
	shutdown     chan struct{}
	shutdownOnce sync.Once // Close's closed flag is not atomic; a second caller must not double-close
	markers      *db.MarkerStore
	// bootMarker is the current run's handle on boot.json; prevBoot is what the
	// previous run left there, folded into the attention panel at start-up.
	bootMarker *bootMarker
	prevBoot   service.BootStatus
	// restoreOutcome is the staged backup restore this start applied or
	// refused, folded into the attention panel with prevBoot.
	restoreOutcome service.RestoreOutcome
	// pushVAPIDKey is loaded by startPushVAPIDKey and installed on svc.Push
	// by startHub once the service layer exists.
	pushVAPIDKey *ecdh.PrivateKey
	// totpKey is loaded by startTOTPKey and consumed by StartRuntime, which
	// builds the AuthService with it.
	totpKey []byte
	// storage is the one upload file store, opened by startErasureMarkers
	// (nil when it could not be) and shared through StartRuntime.
	storage  *storage.Storage
	serveCtx context.Context

	closers []closeStep
	closed  bool

	// failStage makes the named start stage fail instead of running; the
	// failure-injection seam lifecycle_test.go drives, so assertions are about
	// what teardown does with what was already up. Never set outside tests.
	failStage string

	// closeStepBudget overrides the default per-step close budget so a test
	// need not wait ten seconds. A step with its own budget keeps it. Never set
	// outside tests.
	closeStepBudget time.Duration

	// teardownBudget overrides the overall close deadline so a test need not
	// wait fifty seconds. Never set outside tests.
	teardownBudget time.Duration

	// onCloseStep is called with each stage's name just before its close step
	// runs, making the teardown walk observable. Never set outside tests.
	onCloseStep func(stage string)
}

// errStageInjected is what a failStage-selected stage returns, so the
// injection is visibly a test seam in a stack trace.
var errStageInjected = errors.New("start failed (injected)")

// New builds the App around an already-loaded configuration. It starts and
// opens nothing: Run does, so every started stage has a matching close and an
// App never run has nothing to release. The error is for a missing dependency,
// which would otherwise surface as a panic several stages in.
func New(cfg *config.Config, deps Deps) (*App, error) {
	switch {
	case cfg == nil:
		return nil, errors.New("app: New needs a configuration")
	case deps.Log == nil:
		return nil, errors.New("app: New needs a logger")
	case deps.Restart == nil:
		return nil, errors.New("app: New needs a restart coordinator")
	}

	return &App{cfg: cfg, deps: deps, log: deps.Log, shutdown: make(chan struct{})}, nil
}

// onClose registers stage's teardown step; registration order is start order.
func (a *App) onClose(stage string, stop func(context.Context) error) {
	a.onCloseWithin(stage, 0, stop)
}

// onCloseWithin is onClose for a step that needs a budget other than
// closeStepBudget.
func (a *App) onCloseWithin(stage string, budget time.Duration, stop func(context.Context) error) {
	a.closers = append(a.closers, closeStep{stage: stage, budget: budget, stop: stop})
}

// Close stops every started stage in the reverse of start order and is the
// only teardown path. The reverse walk (docs/architecture/server-boundaries.md,
// "Start, drain, stop") guarantees:
//
//   - the audit writer starts after the database opens, so it stops before
//     database.Close and its queue is flushed while the handle is live;
//   - event persistence likewise stops (cancelling bgCtx and joining the
//     pruner) before the handle goes, so no prune is mid-query against a
//     closing pool;
//   - the hub's GracefulStop runs on every return from Run, including an
//     early one, because it calls StopLiveKit, the sole caller of
//     LiveKitProcess.Stop; skipping it orphans the supervised livekit-server.
//
// It reports the first error and runs every later step regardless: the steps
// below a failing one release the database handle, the LiveKit process and the
// audit queue. Later errors are logged. Each step runs under its own budget,
// capped by what is left of one overall teardownBudget, and ctx lends it
// values only: neither its cancellation nor an earlier step's overrun cuts a
// later step short of that cap. Calling it twice is a no-op.
func (a *App) Close(ctx context.Context) error {
	if a.closed {
		return nil
	}
	a.closed = true
	if a.shutdown != nil {
		a.shutdownOnce.Do(func() { close(a.shutdown) })
	}

	defaultBudget := a.closeStepBudget
	if defaultBudget <= 0 {
		defaultBudget = closeStepBudget
	}
	teardown := a.teardownBudget
	if teardown <= 0 {
		teardown = teardownBudget
	}
	overall, cancelOverall := context.WithTimeout(context.WithoutCancel(ctx), teardown)
	defer cancelOverall()
	var first error
	for _, step := range slices.Backward(a.closers) {
		if a.onCloseStep != nil {
			a.onCloseStep(step.stage)
		}
		// Each step gets its own budget, not a share of one deadline: a step
		// that overran (an HTTP drain held open by a long request) must not
		// leave the hub's restart notice, audit drain and event flush on an
		// expired context.
		budget := step.budget
		if budget <= 0 {
			budget = defaultBudget
		}
		stepCtx, cancel := context.WithTimeout(overall, budget)
		started := time.Now()
		err := step.stop(stepCtx)
		cancel()
		a.log.Info("shutdown step finished", "stage", step.stage,
			"duration", time.Since(started).Round(time.Millisecond), "error", err)
		if err == nil {
			continue
		}
		if first == nil {
			first = fmt.Errorf("stopping %s: %w", step.stage, err)
			continue
		}
		a.log.Warn("shutdown step failed after an earlier failure",
			"stage", step.stage, "error", err)
	}
	return first
}
