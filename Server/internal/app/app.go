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
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Deps are the pieces main() owns and hands in.
type Deps struct {
	Version string
	Log     *slog.Logger
	LogBuf  *admin.RingBuffer
	Restart *RestartCoordinator
	// LogLevelVar is the *slog.LevelVar main's log sinks read; nil in tests,
	// where the log-level endpoints report 503.
	LogLevelVar  *slog.LevelVar
	LogBaseLevel slog.Level
}

// closeStep is one teardown step; a zero budget means closeStepBudget.
type closeStep struct {
	stage  string
	budget time.Duration
	stop   func(context.Context) error
}

// App is one server process; each stage registers exactly one closeStep as it
// starts, so a failed start, a serve error and a clean shutdown share one
// teardown path.
type App struct {
	cfg  *config.Config
	deps Deps
	log  *slog.Logger

	// rootCtx is the context Run was given; every other context descends from
	// it.
	rootCtx context.Context
	// bgCtx is the context every background goroutine runs under. bgCancel is
	// registered first so it runs last, as a backstop to the steps that join
	// their goroutines earlier.
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
	// background owns request-path jobs that outlive their request; its close
	// step joins or abandons them before the database closes.
	background *syncutil.Group
	// shutdown is closed at the start of Close to stop work that must not
	// complete during shutdown (the update apply tail).
	shutdown     chan struct{}
	shutdownOnce sync.Once // Close's closed flag is not atomic; a second caller must not double-close
	markers      *db.MarkerStore
	// bootMarker is this run's handle on boot.json; prevBoot is what the
	// previous run left there.
	bootMarker     *bootMarker
	prevBoot       service.BootStatus
	restoreOutcome service.RestoreOutcome
	// pushVAPIDKey is loaded by startPushVAPIDKey and installed on svc.Push by
	// startHub.
	pushVAPIDKey *ecdh.PrivateKey
	// totpKey is loaded by startTOTPKey and consumed by StartRuntime.
	totpKey []byte
	// storage is the one upload file store, opened by startErasureMarkers (nil
	// when it could not be).
	storage *storage.Storage
	// linkPreviews is the one link preview store, opened beside storage and shared by every
	// user of the thumbnail folder (nil when it could not be opened).
	linkPreviews *linkpreview.Store
	serveCtx     context.Context

	closers []closeStep
	closed  bool

	// failStage makes the named start stage fail, to test teardown. Never set
	// outside tests.
	failStage string

	// closeStepBudget overrides the default per-step close budget. Never set
	// outside tests.
	closeStepBudget time.Duration

	// teardownBudget overrides the overall close deadline. Never set outside
	// tests.
	teardownBudget time.Duration

	// onCloseStep is called with each stage's name just before its close step
	// runs. Never set outside tests.
	onCloseStep func(stage string)
}

// errStageInjected is what a failStage-selected stage returns.
var errStageInjected = errors.New("start failed (injected)")

// New builds the App around a loaded configuration and starts nothing: Run
// does, so an App never run has nothing to release.
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

// onCloseWithin is onClose for a step with its own budget.
func (a *App) onCloseWithin(stage string, budget time.Duration, stop func(context.Context) error) {
	a.closers = append(a.closers, closeStep{stage: stage, budget: budget, stop: stop})
}

// Close stops every started stage in reverse start order and is the only
// teardown path (docs/architecture/server-boundaries.md, "Start, drain, stop").
// The reverse walk guarantees:
//
//   - the audit writer and event persistence stop before database.Close, so
//     the queue is flushed and no prune is mid-query on a closing pool;
//   - the hub's GracefulStop runs on every return from Run, because it calls
//     StopLiveKit; skipping it orphans the supervised livekit-server.
//
// It reports the first error and runs every later step regardless, since those
// release the database, LiveKit and audit queue. Each step runs under its own
// budget, capped by what is left of teardownBudget; ctx lends values only, so a
// cancelled ctx or an earlier overrun never cuts a later step short. Calling it
// twice is a no-op.
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
		// Each step gets its own budget, not a share of one deadline: an
		// overrunning step (an HTTP drain) must not leave the hub notice, audit
		// drain and event flush on an expired context.
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
