// Package app owns the server process lifecycle: it opens and migrates the
// database, starts telemetry, plugins, the HTTP router and hub, event
// persistence, the audit writer, the maintenance workers, ACME and the
// listener, serves until a shutdown or restart signal, and tears every stage
// back down through one composite close. main keeps only the CLI dispatch,
// the log sinks and the restart handoff (B3-3).
package app

import (
	"context"
	"fmt"
	"io"
	stdlog "log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
)

// shutdownBudget is the total time Close is given, and the same 30 seconds
// the operator is told about in the "draining connections" log line. The
// per-stage timeouts inside the individual stop steps are budgets of their
// own and are unchanged by the move.
const shutdownBudget = 30 * time.Second

// stage is one start step, in start order. The name is what a failure is
// reported as, so an operator reading `starting audit-writer: ...` knows
// exactly how far the boot got — and it is the key the failure-injection
// test selects on.
type stage struct {
	name  string
	start func() error
}

// stages is the start sequence. Close walks the steps these register in
// reverse, so this list IS the shutdown order read backwards. Two orderings
// here are load-bearing rather than incidental:
//
//   - the database opens before the audit writer and event persistence start,
//     so both stop before the handle closes;
//   - ACME and the HTTP server start AFTER the maintenance loop, so the
//     reverse walk drains in-flight HTTP handlers (whose broadcasts must
//     still reach a live hub) before anything else is stopped — which is the
//     order run()'s explicit shutdown call used to impose by hand.
func (a *App) stages() []stage {
	return []stage{
		{"data-dir", a.startDataDir},
		{"tls", a.startTLS},
		{"database", a.startDatabase},
		{"migrate", a.startMigrate},
		{"erasure-markers", a.startErasureMarkers},
		{"telemetry", a.startTelemetry},
		{"plugins", a.startPlugins},
		{"hub", a.startHub},
		{"router", a.startRouter},
		{"event-persistence", a.startEventPersistence},
		{"audit-writer", a.startAuditWriter},
		{"maintenance", a.startMaintenance},
		{"acme", a.startACME},
		{"http", a.startHTTP},
		{"signals", a.startSignals},
	}
}

// Run starts every stage in order, serves until the listener fails or a
// shutdown or restart signal arrives, and then closes every started stage in
// the reverse order. Close runs on EVERY return path — a failed start, a
// serve error and a clean shutdown alike — which is what keeps a supervised
// LiveKit process from being orphaned by an early return (OC-0027).
//
// A start or serve error is what Run reports; a teardown error surfaces only
// when there is no earlier one to report.
func (a *App) Run(ctx context.Context) (err error) {
	a.rootCtx = ctx
	// WithoutCancel: bgCtx takes ctx's values but NOT its cancellation. The
	// event persister, the audit writer and the maintenance loop run under
	// it, and Close drains in-flight HTTP handlers FIRST precisely so their
	// broadcasts and audit records still reach live consumers — inheriting
	// cancellation would kill all three the instant a caller cancelled,
	// before that drain, and would make caller-context shutdown behave
	// differently from the SIGTERM and restart paths, which cancel only the
	// serve context. Cancelling ctx stops SERVING (serveCtx descends from it
	// in startSignals); when the background work stops is Close's decision.
	bgCtx, bgCancel := context.WithCancel(context.WithoutCancel(ctx))
	// The deferred cancel is only a hard backstop for an App whose Close is
	// somehow never reached; the ordered teardown cancels bgCtx through the
	// first-registered close step, which the reverse walk runs LAST — after
	// the persistence and maintenance steps have joined their goroutines.
	defer bgCancel()
	a.bgCtx, a.bgCancel = bgCtx, bgCancel
	a.onClose("background-context", func(context.Context) error {
		bgCancel()
		return nil
	})

	defer func() {
		// WithoutCancel, not Background: teardown must run its full budget
		// even when the caller's context is what ended the server, while
		// still carrying whatever values that context holds.
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownBudget)
		defer cancel()
		if closeErr := a.Close(closeCtx); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	if startErr := a.start(); startErr != nil {
		return startErr
	}
	return a.serve()
}

// start brings the stages up in order, stopping at the first failure — the
// stages that did come up are already registered with Close, which Run runs
// regardless.
func (a *App) start() error {
	removeOldBinary(a.log)

	for _, st := range a.stages() {
		if st.name == a.failStage {
			return fmt.Errorf("starting %s: %w", st.name, errStageInjected)
		}
		if err := st.start(); err != nil {
			return fmt.Errorf("starting %s: %w", st.name, err)
		}
	}
	return nil
}

// serve blocks until the listener fails or the signal context is cancelled.
// The graceful shutdown that used to follow it inline is now the http stage's
// close step, so it happens on the error path too.
func (a *App) serve() error {
	return serveAndWait(a.serveCtx, a.log, a.deps.Restart, a.srv, a.tlsCfg, a.addr, a.deps.Version)
}

// startDataDir creates the configured data directory and warns about the
// volumes the server writes to. Nothing to close.
func (a *App) startDataDir() error {
	return prepareDataDir(a.log, a.cfg)
}

// startTLS resolves the serving certificate (and, in acme mode, the HTTP-01
// challenge handler the acme stage serves) and prints the startup banner
// above the init logs, as run() did. Nothing to close.
func (a *App) startTLS() error {
	tlsResult, err := auth.LoadOrGenerate(a.cfg.TLS)
	if err != nil {
		return fmt.Errorf("configuring TLS: %w", err)
	}
	a.tlsCfg = tlsResult.TLSConfig
	a.httpHandler = tlsResult.HTTPHandler

	printBanner(a.cfg, a.deps.Version, a.tlsCfg != nil)
	return nil
}

// startDatabase opens the handle and registers its close BEFORE migrating,
// so a migration failure still releases it and its process lock.
func (a *App) startDatabase() error {
	database, err := openDatabase(a.cfg)
	if err != nil {
		return err
	}
	a.database = database
	a.onClose("database", func(context.Context) error { return database.Close() })
	return nil
}

// startMigrate runs the migrations and clears state left by a previous run.
func (a *App) startMigrate() error {
	return initDatabase(a.log, a.cfg, a.database, a.deps.Restart)
}

// startErasureMarkers opens the deletion-marker file and replays it against
// the migrated database before anything can serve (B4-10): what a restored
// backup brought back is erased again here. Its close releases the file.
func (a *App) startErasureMarkers() error {
	markers, err := openMarkers(context.Background(), a.log, a.cfg, a.database)
	if err != nil {
		return err
	}
	a.markers = markers
	a.onClose("erasure-markers", func(context.Context) error { return markers.Close() })
	return nil
}

// startTelemetry initialises OpenTelemetry. Its shutdown is bounded by its
// own 5s budget inside the returned step.
func (a *App) startTelemetry() error {
	stop := initTelemetry(a.log, a.cfg)
	a.onClose("telemetry", func(context.Context) error {
		stop()
		return nil
	})
	return nil
}

// startPlugins constructs the plugin runtime before the router, so the router
// can wire the live registry into the plugin admin handler. A nil registry is
// the disabled case and has nothing to close.
func (a *App) startPlugins() error {
	a.plugins = initPlugins(a.bgCtx, a.log, a.cfg, a.database)
	a.onClose("plugins", func(ctx context.Context) error {
		closePlugins(ctx, a.plugins)
		return nil
	})
	return nil
}

// startHub builds the hub and the collaborators it shares with the router
// and starts the dispatch goroutine — B3-3 moved all of that out of
// api.NewRouter so the hub has exactly one owner, and B3-4 moved the pre-Run
// wiring into ws.HubOptions, so an incomplete hub fails this start step
// instead of panicking later.
//
// Its close step is GracefulStopContext, the only caller of
// LiveKitProcess.Stop and what closes the dispatch goroutine. gracefulOnce
// makes it idempotent alongside the stop the http step performs on the normal
// path, so it is reached on every return from Run and a supervised
// livekit-server process is never orphaned (OC-0027).
func (a *App) startHub() error {
	rt, err := StartRuntime(a.cfg, a.database, a.plugins)
	if err != nil {
		return err
	}
	a.runtime = rt
	a.hub = a.runtime.Hub
	// The routes' erasures record markers in the file start-up just replayed.
	if rt.Services != nil && rt.Services.Erasure != nil {
		rt.Services.Erasure.SetMarkers(a.markers)
	}
	a.onClose("hub", func(ctx context.Context) error {
		a.runtime.Hub.GracefulStopContext(ctx)
		return nil
	})
	return nil
}

// startRouter mounts the HTTP handler over the already-built collaborators.
// Its close step stops the router's own background goroutine (rate-limiter
// cleanup); the hub it serves is stopped by the step above.
func (a *App) startRouter() error {
	router, cleanup := api.NewRouter(a.cfg, a.database, a.deps.Version, a.deps.LogBuf, a.plugins, a.runtime)
	a.router = router
	a.onClose("router", func(context.Context) error {
		cleanup()
		return nil
	})
	return nil
}

// startEventPersistence seeds the hub's replay state and, when persistence is
// enabled, starts the persister and pruner. Its stop cancels bgCtx and joins
// the pruner, which the reverse walk runs before database.Close so no prune
// is mid-query against a closing pool.
func (a *App) startEventPersistence() error {
	a.persister, a.prunerDone = startEventPersister(a.bgCtx, a.log, a.cfg, a.hub, a.database)
	a.onClose("event-persistence", func(ctx context.Context) error {
		stopEventPersister(ctx, a.log, a.bgCancel, a.persister, a.prunerDone)
		return nil
	})
	return nil
}

// startAuditWriter moves audit-log INSERTs off the request path. It starts
// after the database opens, so the reverse walk drains its queue while the
// handle is still live.
func (a *App) startAuditWriter() error {
	a.auditWriter = newAuditWriter(a.bgCtx, a.database)
	a.onClose("audit-writer", func(ctx context.Context) error {
		stopAuditWriter(ctx, a.auditWriter)
		return nil
	})
	return nil
}

// startMaintenance starts the periodic purge of expired sessions, scheduled
// backups and orphaned attachments. Its stop joins the loop, bounded, so an
// in-flight tick (which can hold the writer — scheduled backups run VACUUM
// INTO) is not still using the database when the handle closes.
func (a *App) startMaintenance() error {
	stop := startMaintenanceLoop(a.bgCtx, a.log, a.cfg, a.database, a.runtime.Services.Settings, a.runtime.Services.Erasure)
	a.onClose("maintenance", func(context.Context) error {
		stop()
		return nil
	})
	return nil
}

// startACME serves the HTTP-01 challenge and the HTTP→HTTPS redirect on :80
// when Let's Encrypt is configured, and is a no-op otherwise. It has no close
// step of its own: the http step below shuts both servers down together, in
// the order the drain requires.
func (a *App) startACME() error {
	a.acmeSrv = startACMEServer(a.log, a.httpHandler)
	return nil
}

// startHTTP builds the main server and registers the ordered graceful
// shutdown — ACME, then in-flight HTTP handlers, then the hub. It starts last
// of the real stages so that shutdown is the FIRST thing the reverse walk
// does: in-flight handlers' broadcasts must still reach a live hub and event
// persister, or the frames vanish from the replay store across the restart.
func (a *App) startHTTP() error {
	a.addr = fmt.Sprintf(":%d", a.cfg.Server.Port)
	a.srv = &http.Server{
		Addr:         a.addr,
		Handler:      a.router,
		TLSConfig:    a.tlsCfg,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
		ErrorLog:     stdlog.New(io.Discard, "", 0), // suppress TLS handshake noise
	}
	a.onClose("http", func(ctx context.Context) error {
		return shutdownServers(ctx, a.log, a.srv, a.acmeSrv, a.hub)
	})
	return nil
}

// startSignals arms the shutdown context. The coordinator's context is the
// parent, so a programmatic restart request (rc.Request) drains exactly like
// a SIGTERM — including on Windows, where a process cannot signal itself.
// Signals arriving mid-drain are swallowed until the stop step runs, same as
// on the real-signal path.
func (a *App) startSignals() error {
	parent, cancelParent := context.WithCancel(a.rootCtx)
	// A restart request cancels the same context a signal would, so
	// rc.Request drains through the identical path — including on Windows,
	// where a process cannot signal itself. AfterFunc rather than a
	// goroutine so there is nothing to leak if neither ever fires.
	stopWatch := context.AfterFunc(a.deps.Restart.Context(), cancelParent)
	serveCtx, stopSignals := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	a.serveCtx = serveCtx
	a.onClose("signals", func(context.Context) error {
		stopSignals()
		stopWatch()
		cancelParent()
		return nil
	})
	return nil
}
