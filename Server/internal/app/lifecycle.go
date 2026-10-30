// Package app owns the server process lifecycle: it opens and migrates the
// database, starts telemetry, plugins, the HTTP router and hub, event
// persistence, the audit writer, the maintenance workers, ACME and the
// listener, serves until a shutdown or restart signal, and tears every stage
// back down through one composite close. main keeps only the CLI dispatch,
// the log sinks and the restart handoff.
package app

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	stdlog "log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

// closeStepBudget bounds each close step on its own, except the HTTP drain; the
// shorter timeouts inside some stop steps sit within it.
const closeStepBudget = 10 * time.Second

// httpDrainBudget bounds the "http" close step. It matches the server's Read
// and Write timeouts, so a request the server allows (a slow upload or export
// download) finishes before the hub, audit writer and database stop under it.
const httpDrainBudget = 30 * time.Second

// teardownBudget caps the whole close walk so a teardown finishes inside
// systemd's TimeoutStopSec=60, which an installed unit keeps even after an
// update raises it.
const teardownBudget = 50 * time.Second

// Run starts every stage in order, serves until the listener fails or a
// shutdown or restart signal arrives, then closes every started stage in
// reverse order. Close runs on every return path, which keeps a supervised
// LiveKit process from being orphaned by an early return. A start or serve
// error is what Run reports; a teardown error surfaces only when there is none.
func (a *App) Run(ctx context.Context) (err error) {
	a.rootCtx = ctx
	// WithoutCancel: bgCtx takes ctx's values but not its cancellation. The
	// event persister, audit writer and maintenance loop run under it, and
	// Close drains in-flight HTTP handlers first so their broadcasts and audit
	// records still reach live consumers; inheriting cancellation would kill
	// all three at once and make caller-context shutdown differ from the
	// SIGTERM and restart paths, which cancel only the serve context.
	// Cancelling ctx stops serving; when background work stops is Close's call.
	bgCtx, bgCancel := context.WithCancel(context.WithoutCancel(ctx))
	// The deferred cancel is a hard backstop; the ordered teardown cancels
	// bgCtx through the first-registered close step, which the reverse walk runs
	// last, after the persistence and maintenance steps have joined.
	defer bgCancel()
	a.bgCtx, a.bgCancel = bgCtx, bgCancel
	a.onClose("background-context", func(context.Context) error {
		bgCancel()
		return nil
	})

	defer func() {
		// Close gives every step its own budget and ignores ctx's cancellation,
		// so teardown runs in full while still carrying ctx's values.
		if closeErr := a.Close(ctx); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	if startErr := a.start(); startErr != nil {
		return startErr
	}
	return a.serve()
}

// start brings the stages up in order, stopping at the first failure; the
// stages that came up are already registered with Close.
func (a *App) start() error {
	for _, st := range a.stages() {
		if st.name == a.failStage {
			return fmt.Errorf("starting %s: %w", st.name, errStageInjected)
		}
		if err := st.start(); err != nil {
			return fmt.Errorf("starting %s: %w", st.name, err)
		}
	}
	// Only once every stage is up is the previous binary safe to remove: doing
	// it first left no chatserver.old-* to roll back to after a migration error
	// or any other start failure, and under systemd Restart=always the unit has
	// nothing local to fall back on. The schema-ahead check in db.MigrateFS
	// stops that copy from booting on a newer schema.
	removeOldBinaryFn(a.log)
	if a.bootMarker != nil {
		a.bootMarker.reported()
	}
	return nil
}

// serve blocks until the listener fails or the signal context is cancelled.
// Graceful shutdown is the http stage's close step, so it runs on the error
// path too.
func (a *App) serve() error {
	return serveAndWait(a.serveCtx, a.log, a.deps.Restart, a.srv, a.ln, a.tlsCfg, a.addr, a.deps.Version)
}

// startDataDir creates the configured data directory and warns about the
// volumes the server writes to.
func (a *App) startDataDir() error {
	return prepareDataDir(a.log, a.cfg)
}

// startTLS resolves the serving certificate (and, in acme mode, the HTTP-01
// challenge handler the acme stage serves) and prints the startup banner above
// the init logs.
func (a *App) startTLS() error {
	tlsCfg := a.cfg.TLS
	tlsCfg.HTTPSPort = a.cfg.Server.Port
	tlsResult, err := auth.LoadOrGenerate(tlsCfg)
	if err != nil {
		return fmt.Errorf("configuring TLS: %w", err)
	}
	a.tlsCfg = tlsResult.TLSConfig
	a.httpHandler = tlsResult.HTTPHandler
	// The admin dashboard and the setup wizard's finish step surface the served
	// certificate (acme's after its first handshake); set before the router
	// mounts the admin handler.
	admin.SetServedCertificate(tlsCfg.Mode, tlsResult.Served.Current)

	printBanner(a.cfg, a.deps.Version, a.tlsCfg != nil, tlsResult.Fingerprint)
	return nil
}

// startDatabase opens the handle and registers its close before migrating, so
// a migration failure still releases it and its process lock.
func (a *App) startDatabase() error {
	database, err := openDatabase(a.cfg)
	if err != nil {
		return err
	}
	a.database = database
	a.onClose("database", func(context.Context) error { return database.Close() })
	// Periodic PRAGMA optimize; registered after the database close, so the
	// reverse walk stops and joins it first.
	optCtx, optCancel := context.WithCancel(a.bgCtx)
	optDone := database.StartOptimizer(optCtx, 0)
	a.onClose("db-optimize", func(ctx context.Context) error {
		optCancel()
		select {
		case <-optDone:
		case <-ctx.Done():
			a.log.Warn("database optimizer did not stop before the close budget ran out")
		}
		return nil
	})
	return nil
}

// startMigrate runs the migrations and clears state left by a previous run.
func (a *App) startMigrate() error {
	if err := initDatabase(a.log, a.cfg, a.database, a.deps.Restart); err != nil {
		return err
	}
	a.restoreOutcome = recordRestoreResult(a.log, a.cfg.Database.Path, a.database)
	return nil
}

// startErasureMarkers opens the deletion-marker file and replays it against
// the migrated database before anything can serve, erasing again what a
// restored backup brought back.
func (a *App) startErasureMarkers() error {
	// The one upload store: opened here because the replay removes erased
	// accounts' files, and handed to StartRuntime so the router and the
	// maintenance loop share it.
	a.storage = OpenStorage(a.log, a.cfg)
	markers, err := openMarkers(context.Background(), a.log, a.cfg, a.database, a.storage)
	if err != nil {
		return err
	}
	a.markers = markers
	a.onClose("erasure-markers", func(context.Context) error { return markers.Close() })
	return nil
}

// startPushVAPIDKey loads (or generates, on a confirmed absence) the Web Push
// VAPID key beside totp.key and erasure.key, regardless of push.enabled: the
// maintenance sweep needs the key id to recognise and remove rows a rotation
// orphaned even while the feature is off. A load failure is fatal at start-up,
// as for the erasure key. startHub installs the key on svc.Push.
func (a *App) startPushVAPIDKey() error {
	key, err := auth.LoadOrGeneratePushVAPIDKey(a.cfg.Server.DataDir)
	if err != nil {
		return fmt.Errorf("push VAPID key: %w", err)
	}
	a.pushVAPIDKey = key
	return nil
}

// startTelemetry initialises OpenTelemetry; its shutdown has its own 5s budget.
func (a *App) startTelemetry() error {
	stop := initTelemetry(a.log, a.cfg)
	a.onClose("telemetry", func(context.Context) error {
		stop()
		return nil
	})
	return nil
}

// startPlugins constructs the plugin runtime before the router, which wires
// the live registry into the plugin admin handler. A nil registry is the
// disabled case.
func (a *App) startPlugins() error {
	a.plugins = initPlugins(a.bgCtx, a.log, a.cfg, a.database)
	a.onClose("plugins", func(ctx context.Context) error {
		closePlugins(ctx, a.plugins)
		return nil
	})
	return nil
}

// pushDispatchEnabled is the one gate before constructing a PushDispatcher and
// installing it on MessageService: both push.enabled and push.dispatch_enabled
// must be true, since storage on with dispatch off (what an upgraded install
// starts in) must never dispatch. TestPushDispatchGate_RequiresBothKeys pins
// the "&&", not just its effect.
func pushDispatchEnabled(cfg *config.Config) bool {
	return cfg.Push.Enabled && cfg.Push.DispatchEnabled
}

// startHub builds the hub and the collaborators it shares with the router and
// starts the dispatch goroutine, here rather than in api.NewRouter so the hub
// has one owner; the pre-Run wiring is in ws.HubOptions, so an incomplete hub
// fails this step instead of panicking later.
//
// Its close step is stopHub: GracefulStopContext, which calls StopLiveKit (the
// sole caller of LiveKitProcess.Stop), then joins the dispatch goroutine.
// gracefulOnce makes it idempotent alongside the hub-notice step's stop, so it
// is reached on every return from Run and a supervised livekit-server is never
// orphaned.
func (a *App) startHub() error {
	rt, err := StartRuntime(a.cfg, a.database, a.plugins,
		RuntimeInputs{Version: a.deps.Version, TOTPKey: a.totpKey, Storage: a.storage})
	if err != nil {
		return err
	}
	a.runtime = rt
	a.startLimiterCleanup(rt.Limiter)
	a.hub = a.runtime.Hub
	a.afterHubStart(rt.Services)
	// The emergency restart path must stop LiveKit even if an earlier shutdown
	// step wedges before the hub's closer runs.
	a.deps.Restart.setCompanionStop(a.hub.StopLiveKit)
	// The routes' erasures record markers in the file start-up replayed.
	if rt.Services != nil && rt.Services.Erasure != nil {
		rt.Services.Erasure.SetMarkers(a.markers)
	}
	if rt.Services != nil && rt.Services.Retention != nil {
		rt.Services.Retention.SetMarkers(a.markers)
	}
	// The VAPID key startPushVAPIDKey loaded, installed once the service layer
	// exists. SetSubscriptionTTL(0) falls back to the PushService default, so a
	// partial wiring (a direct StartRuntime call in a test) stays usable.
	if rt.Services != nil && rt.Services.Push != nil {
		rt.Services.Push.SetVAPIDKey(a.pushVAPIDKey)
		rt.Services.Push.SetSubscriptionTTL(time.Duration(a.cfg.Push.SubscriptionTTLDays) * 24 * time.Hour)
		rt.Services.Push.SetContact(a.cfg.Push.Contact)
	}
	// Web Push dispatch is a second opt-in on top of push.enabled, so an
	// operator who enabled storage before dispatch existed does not acquire it
	// by upgrade. SetPushNotifier is never called otherwise, leaving the nil
	// default (TestPushDispatch_OffByDefaultSendsNothing).
	if pushDispatchEnabled(a.cfg) &&
		rt.Services != nil && rt.Services.Messages != nil && rt.Services.Push != nil && rt.Services.Permissions != nil {
		dispatcher := service.NewPushDispatcher(a.database, rt.Services.Permissions, rt.Services.Push, a.hub.IsUserConnected, nil)
		rt.Services.Messages.SetPushNotifier(dispatcher)
		rt.Services.PushDispatch = dispatcher
	}
	a.onClose("hub", func(ctx context.Context) error {
		return stopHub(ctx, a.runtime.Hub, a.deps.Restart.noticeReason())
	})
	// Windowed metrics sampler, registered right after "hub" so the reverse
	// walk joins it before the hub stops and the database closes: it reads hub
	// atomics and both pools' Stats(). It runs on bgCtx.
	if rt.MetricsWindows != nil {
		a.startMetricsWindows(rt.MetricsWindows)
	}
	// Mention badges' single bounded worker. Its close step flushes every
	// queued job and joins the loop, and the reverse walk runs it before the
	// database closes, so a coalesced window is never lost at shutdown. The
	// loop context is not bgCtx: the event-persistence close step cancels
	// bgCtx and the reverse walk reaches that first, which would cancel the
	// drain before it wrote. The close step's own bounded ctx is the live one.
	if rt.Services != nil && rt.Services.Messages != nil {
		loopCtx, cancel := context.WithCancel(context.WithoutCancel(a.bgCtx))
		stop := rt.Services.Messages.StartMentionWorker(loopCtx)
		a.onClose("mention-worker", func(ctx context.Context) error {
			stop(ctx)
			cancel()
			return nil
		})
	}
	a.startBackgroundJobs(rt)
	return nil
}

// startRouter mounts the HTTP handler over the already-built collaborators. It
// owns no goroutine, but keeps its close step for NewRouter's cleanup hook; the
// hub it serves is stopped by the step above.
func (a *App) startRouter() error {
	a.runtime.SetupToken = rand.Text()
	router, cleanup := api.NewRouter(a.cfg, a.database, a.deps.Version, a.deps.LogBuf, a.plugins, a.runtime)
	a.router = router
	// Print the token only while setup is open. A failed check prints it too:
	// a silent start would leave the owner no way through the wizard.
	if svc := a.runtime.Services; svc != nil && svc.Setup != nil {
		if open, err := svc.Setup.NeedsSetup(a.rootCtx); open || err != nil {
			printSetupToken(a.runtime.SetupToken)
		}
	}
	a.onClose("router", func(context.Context) error {
		cleanup()
		return nil
	})
	return nil
}

// startEventPersistence seeds the hub's replay state and, when persistence is
// enabled, starts the persister and pruner. Its stop cancels bgCtx and joins
// the pruner, which the reverse walk runs before database.Close so no prune is
// mid-query against a closing pool.
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
// handle is live.
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
// in-flight tick (scheduled backups run VACUUM INTO) is not using the
// database when the handle closes.
func (a *App) startMaintenance() error {
	stop := startMaintenanceLoop(a.bgCtx, a.log, a.cfg, a.database, a.runtime.Services, a.runtime.Storage)
	a.onClose("maintenance", func(context.Context) error {
		stop()
		return nil
	})
	return nil
}

// startACME serves the HTTP-01 challenge and the HTTP→HTTPS redirect on :80
// when Let's Encrypt is configured. It has no close step: the http step shuts
// both servers down together, in the order the drain requires.
func (a *App) startACME() error {
	a.acmeSrv = startACMEServer(a.log, a.httpHandler)
	return nil
}

// startHTTP builds the main server and registers the ordered graceful
// shutdown: the http step (ACME, then in-flight handlers, within
// httpDrainBudget), then the hub-notice step. It starts last of the real
// stages so shutdown is the first thing the reverse walk does: in-flight
// handlers' broadcasts must still reach a live hub and event persister, or
// the frames vanish from the replay store across the restart.
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
	// Shutdown closes only the listeners Serve has taken, so a later stage
	// failing before serve() would leave the port bound. Registered before the
	// http step so the reverse walk runs it after Shutdown.
	a.onClose("listener", func(context.Context) error {
		if a.ln != nil {
			_ = a.ln.Close()
		}
		return nil
	})
	// The hub stops right after the drain (notify clients, close every socket
	// once the notice window ends, stop LiveKit) as its own step, so the notice
	// window keeps its budget however long the drain took; the later "hub"
	// step only joins the dispatch loop. The notice names the restart's intent
	// so clients hear "update" rather than "shutdown".
	a.onClose("hub-notice", func(ctx context.Context) error {
		a.hub.GracefulStopContext(ctx, a.deps.Restart.noticeReason())
		return nil
	})
	a.onCloseWithin("http", httpDrainBudget, func(ctx context.Context) error {
		return shutdownServers(ctx, a.log, a.srv, a.acmeSrv)
	})
	// An open admin log stream never returns and Shutdown waits for every
	// active handler, so end the streams as Shutdown begins.
	if a.deps.LogBuf != nil {
		a.srv.RegisterOnShutdown(a.deps.LogBuf.EndStreams)
	}
	// Bind here, not in serve(): a port that cannot be bound must fail start()
	// before the previous binary is removed.
	return serveWithBindRetry(a.log, "server", func() (err error) {
		a.ln, err = net.Listen("tcp", a.addr)
		return err
	})
}

// startSignals arms the shutdown context. The coordinator's context is the
// parent, so a programmatic restart request drains like a SIGTERM, including
// on Windows where a process cannot signal itself. Signals arriving mid-drain
// are swallowed until the stop step runs.
func (a *App) startSignals() error {
	parent, cancelParent := context.WithCancel(a.rootCtx)
	// AfterFunc rather than a goroutine, so nothing leaks if the restart
	// context never fires.
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
