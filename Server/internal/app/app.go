package app

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/plugin"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Deps are the pieces main() owns and hands in: the build version it injects
// with `-ldflags -X main.version`, the logger and the ring buffer both log
// sinks are already wired against, and the restart coordinator whose handoff
// main() performs after Run returns. Everything else the process needs, the
// App builds.
type Deps struct {
	Version string
	Log     *slog.Logger
	LogBuf  *admin.RingBuffer
	Restart *RestartCoordinator
}

// closeStep is one teardown step: the stage that registered it, and how that
// stage stops. Steps are appended in START order and Close walks them
// backwards.
type closeStep struct {
	stage string
	stop  func(context.Context) error
}

// App is one server process. Each stage the lifecycle starts owns a field
// here and registers exactly one closeStep as it comes up, so there is a
// single teardown path — taken on a failed start, a serve error and a clean
// shutdown alike — instead of the `defer` stack run() used to carry.
type App struct {
	cfg  *config.Config
	deps Deps
	log  *slog.Logger

	// rootCtx is the context Run was given: the process context every other
	// context here descends from, so cancelling it stops the server the same
	// way a signal or a restart request does.
	rootCtx context.Context
	// bgCtx is the context every background goroutine (event persister,
	// event pruner, plugin loader, maintenance loop) runs under. bgCancel is
	// registered as the FIRST closer, so it runs LAST — the persistence and
	// maintenance steps cancel it and join their goroutines earlier, and
	// this is only their backstop.
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
	acmeSrv     *http.Server
	persister   *ws.EventPersister
	prunerDone  <-chan struct{}
	auditWriter *db.AuditWriter
	serveCtx    context.Context

	closers []closeStep
	closed  bool

	// failStage makes the named start stage fail instead of running. It is
	// the failure-injection seam lifecycle_test.go drives: every stage before
	// it starts for real, so the assertions are about what teardown does with
	// what was already up. Never set outside tests.
	failStage string

	// onCloseStep is called with each stage's name just before its close step
	// runs. It makes the teardown walk observable, which is how the tests
	// assert what is still alive at a given point in it. Never set outside
	// tests.
	onCloseStep func(stage string)
}

// errStageInjected is what a failStage-selected stage returns. It exists so
// the injection is visibly a test seam in a stack trace rather than a
// plausible production error.
var errStageInjected = errors.New("start failed (injected)")

// New builds the App around an already-loaded configuration. It starts
// nothing and opens nothing: Run does that, so every started stage has a
// matching close on every return path and an App that is never run has
// nothing to release. The error is for a missing dependency — a nil logger
// or coordinator would only surface as a panic several stages in.
func New(cfg *config.Config, deps Deps) (*App, error) {
	switch {
	case cfg == nil:
		return nil, errors.New("app: New needs a configuration")
	case deps.Log == nil:
		return nil, errors.New("app: New needs a logger")
	case deps.Restart == nil:
		return nil, errors.New("app: New needs a restart coordinator")
	}

	return &App{cfg: cfg, deps: deps, log: deps.Log}, nil
}

// onClose registers stage's teardown step. Order of registration is start
// order; Close reverses it.
func (a *App) onClose(stage string, stop func(context.Context) error) {
	a.closers = append(a.closers, closeStep{stage: stage, stop: stop})
}

// Close stops every started stage in the reverse of the order they started,
// and is the only teardown path in the process. Three ordering facts depend
// on it and are what the reverse walk is FOR
// (docs/architecture/server-boundaries.md, "Start, drain, stop"):
//
//   - the audit writer starts after the database opens, so it stops before
//     database.Close and its queue is flushed while the handle is still live;
//   - event persistence likewise stops (cancelling bgCtx and joining the
//     pruner) before the handle goes, so no prune is mid-query against a
//     closing pool;
//   - the hub's GracefulStop runs on EVERY return from Run, including an
//     early one, because it is the only caller of LiveKitProcess.Stop and
//     skipping it orphans the supervised livekit-server process (OC-0027).
//
// It reports the FIRST error and runs every later step regardless: the steps
// below a failing one are the ones that release the database handle, the
// LiveKit process and the audit queue, so aborting the walk would leak
// exactly what teardown exists to reclaim. Later errors are logged.
// Calling it twice is a no-op.
func (a *App) Close(ctx context.Context) error {
	if a.closed {
		return nil
	}
	a.closed = true

	var first error
	for i := len(a.closers) - 1; i >= 0; i-- {
		step := a.closers[i]
		if a.onCloseStep != nil {
			a.onCloseStep(step.stage)
		}
		err := step.stop(ctx)
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
