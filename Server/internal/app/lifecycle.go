// Package app owns the server process lifecycle: it starts every stage, serves
// until a shutdown or restart signal, and tears every stage down through one
// composite close. main keeps only the CLI dispatch, the log sinks and the
// restart handoff.
package app

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/service"
)

// closeStepBudget bounds each close step on its own, except the HTTP drain.
const closeStepBudget = 10 * time.Second

// httpDrainBudget bounds the "http" close step. Matches the server's Read/Write timeouts, so an allowed
// request finishes before the hub/DB stop.
const httpDrainBudget = 30 * time.Second

// teardownBudget caps the whole close walk so it finishes inside systemd's
// TimeoutStopSec=60, which an installed unit keeps even after an update raises
// it.
const teardownBudget = 50 * time.Second

// Run starts every stage in order, serves until the listener fails or a
// shutdown or restart signal arrives, then closes every started stage in
// reverse order, so an early return cannot orphan a supervised LiveKit.
func (a *App) Run(ctx context.Context) (err error) {
	a.rootCtx = ctx
	// bgCtx takes ctx's values but not its cancellation: Close drains in-flight
	// HTTP handlers first so their broadcasts and audit records still reach
	// live consumers, and inheriting cancellation would make caller-context
	// shutdown differ from the SIGTERM and restart paths.
	bgCtx, bgCancel := context.WithCancel(context.WithoutCancel(ctx))
	// Hard backstop; the ordered teardown cancels bgCtx through its first-registered close step.
	defer bgCancel()
	a.bgCtx, a.bgCancel = bgCtx, bgCancel
	a.onClose("background-context", func(context.Context) error {
		bgCancel()
		return nil
	})

	defer func() {
		// Close gives every step its own budget and ignores ctx's cancellation,
		// so teardown runs in full.
		if closeErr := a.Close(ctx); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	if startErr := a.start(); startErr != nil {
		return startErr
	}
	return a.serve()
}

// start brings the stages up in order, stopping at the first failure; stages
// that came up are already registered with Close.
func (a *App) start() error {
	for _, st := range a.stages() {
		if st.name == a.failStage {
			return fmt.Errorf("starting %s: %w", st.name, errStageInjected)
		}
		if err := st.start(); err != nil {
			return fmt.Errorf("starting %s: %w", st.name, err)
		}
	}
	// Only once every stage is up: removing earlier leaves no chatserver.old-* to roll back to.
	removeOldBinaryFn(a.log)
	if a.bootMarker != nil {
		a.bootMarker.reported()
	}
	return nil
}

// serve blocks until the listener fails or the signal context is cancelled.
func (a *App) serve() error {
	return serveAndWait(a.serveCtx, a.log, a.deps.Restart, a.srv, a.ln, a.tlsCfg, a.addr, a.deps.Version)
}

func (a *App) startDataDir() error {
	return prepareDataDir(a.log, a.cfg)
}

// startTLS resolves the serving certificate (and, in acme mode, the HTTP-01
// handler) and prints the startup banner.
func (a *App) startTLS() error {
	tlsCfg := a.cfg.TLS
	tlsCfg.HTTPSPort = a.cfg.Server.Port
	tlsResult, err := auth.LoadOrGenerate(tlsCfg)
	if err != nil {
		return fmt.Errorf("configuring TLS: %w", err)
	}
	a.tlsCfg = tlsResult.TLSConfig
	a.httpHandler = tlsResult.HTTPHandler
	admin.SetServedCertificate(tlsCfg.Mode, tlsResult.Served.Current)

	printBanner(a.cfg, a.deps.Version, a.tlsCfg != nil, tlsResult.Fingerprint)
	return nil
}

// startDatabase registers the close before migrating, so a migration failure
// still releases the handle and its process lock.
func (a *App) startDatabase() error {
	database, err := openDatabase(a.cfg)
	if err != nil {
		return err
	}
	a.database = database
	a.onClose("database", func(context.Context) error { return database.Close() })
	// Registered after the database close, so the reverse walk stops and joins it first.
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

func (a *App) startMigrate() error {
	if err := initDatabase(a.log, a.cfg, a.database, a.deps.Restart); err != nil {
		return err
	}
	a.restoreOutcome = recordRestoreResult(a.log, a.cfg.Database.Path, a.database)
	return nil
}

// startErasureMarkers replays the deletion markers against the migrated
// database before anything serves, erasing again what a restored backup brought
// back.
func (a *App) startErasureMarkers() error {
	// Opened here because the replay removes erased accounts' files;
	// StartRuntime shares it with the router and maintenance loop.
	a.storage = OpenStorage(a.log, a.cfg)
	a.linkPreviews = OpenLinkPreviews(a.log, a.cfg, a.database)
	markers, err := openMarkers(context.Background(), a.log, a.cfg, a.database, a.storage)
	if err != nil {
		return err
	}
	a.markers = markers
	a.onClose("erasure-markers", func(context.Context) error { return markers.Close() })
	return nil
}

// startPushVAPIDKey loads (or generates) the Web Push VAPID key regardless of
// push.enabled: the maintenance sweep needs the key id to remove rows a
// rotation orphaned. A load failure is fatal.
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

// startPlugins constructs the plugin runtime before the router; a nil registry
// means disabled.
func (a *App) startPlugins() error {
	a.plugins = initPlugins(a.bgCtx, a.log, a.cfg, a.database)
	a.onClose("plugins", func(ctx context.Context) error {
		closePlugins(ctx, a.plugins)
		return nil
	})
	return nil
}

// pushDispatchEnabled requires both push.enabled and push.dispatch_enabled:
// storage on with dispatch off (what an upgraded install starts in) must never
// dispatch. TestPushDispatchGate_RequiresBothKeys pins the "&&".
func pushDispatchEnabled(cfg *config.Config) bool {
	return cfg.Push.Enabled && cfg.Push.DispatchEnabled
}

// startHub builds the hub and the collaborators it shares with the router, here
// rather than in api.NewRouter so the hub has one owner. Its close step is
// stopHub: GracefulStopContext calls StopLiveKit, then joins the dispatch
// goroutine. gracefulOnce makes it idempotent alongside the hub-notice step, so
// a supervised livekit-server is never orphaned.
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
	if rt.Services != nil && rt.Services.Erasure != nil {
		rt.Services.Erasure.SetMarkers(a.markers)
	}
	if rt.Services != nil && rt.Services.Retention != nil {
		rt.Services.Retention.SetMarkers(a.markers)
	}
	// SetSubscriptionTTL(0) falls back to the PushService default, so a partial
	// wiring (a direct StartRuntime call in a test) stays usable.
	if rt.Services != nil && rt.Services.Push != nil {
		rt.Services.Push.SetVAPIDKey(a.pushVAPIDKey)
		rt.Services.Push.SetSubscriptionTTL(time.Duration(a.cfg.Push.SubscriptionTTLDays) * 24 * time.Hour)
		rt.Services.Push.SetContact(a.cfg.Push.Contact)
	}
	// Phones can register while nothing is sent to them: say so once, since the
	// owner sees only "push on" in the config.
	if a.cfg.Push.Enabled && !a.cfg.Push.DispatchEnabled {
		a.log.Warn("push: devices can register but push.dispatch_enabled is off, so no push notification is sent")
	}
	// Second opt-in on top of push.enabled, so an upgraded install does not acquire dispatch.
	if pushDispatchEnabled(a.cfg) &&
		rt.Services != nil && rt.Services.Messages != nil && rt.Services.Push != nil && rt.Services.Permissions != nil {
		dispatcher := service.NewPushDispatcher(a.database, rt.Services.Permissions, rt.Services.Push, a.hub.IsUserConnected, nil)
		rt.Services.Messages.SetPushNotifier(dispatcher)
		a.hub.SetRingPusher(dispatcher)
		rt.Services.PushDispatch = dispatcher
	}
	a.onClose("hub", func(ctx context.Context) error {
		return stopHub(ctx, a.runtime.Hub, a.deps.Restart.noticeReason())
	})
	// Registered right after "hub" so the reverse walk joins it before the hub
	// stops and the database closes: it reads hub atomics and both pools'
	// Stats().
	if rt.MetricsWindows != nil {
		a.startMetricsWindows(rt.MetricsWindows)
	}
	if rt.SystemStats != nil {
		a.startSystemStats(rt.SystemStats)
	}
	if rt.LiveKitStats != nil {
		a.startLiveKitStats(rt.LiveKitStats)
	}
	// The mention worker's close step flushes queued jobs before the database
	// closes. Its loop context is not bgCtx: event persistence cancels bgCtx
	// first, which would cancel the drain before it wrote.
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

// startRouter mounts the HTTP handler over the already-built collaborators; its
// close step exists for NewRouter's cleanup hook.
func (a *App) startRouter() error {
	a.runtime.SetupToken = rand.Text()
	router, cleanup := api.NewRouter(a.cfg, a.database, a.deps.Version, a.deps.LogBuf, a.plugins, a.runtime)
	a.router = router
	// Print the token only while setup is open; a failed check prints it too,
	// since silence would leave the owner no way through the wizard.
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

// startEventPersistence seeds the hub's replay state and, when enabled, starts
// the persister and pruner.
func (a *App) startEventPersistence() error {
	a.persister, a.prunerDone = startEventPersister(a.bgCtx, a.log, a.cfg, a.hub, a.database)
	a.onClose("event-persistence", func(ctx context.Context) error {
		stopEventPersister(ctx, a.log, a.bgCancel, a.persister, a.prunerDone)
		return nil
	})
	return nil
}

// startAuditWriter moves audit-log INSERTs off the request path; it starts
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
// backups and orphaned attachments.
func (a *App) startMaintenance() error {
	stop := startMaintenanceLoop(a.bgCtx, a.log, a.cfg, a.database, a.runtime.Services, a.runtime.Storage, a.linkPreviews)
	a.onClose("maintenance", func(context.Context) error {
		stop()
		return nil
	})
	return nil
}

// startACME serves the HTTP-01 challenge and the HTTP-to-HTTPS redirect on :80.
func (a *App) startACME() error {
	a.acmeSrv = startACMEServer(a.log, a.httpHandler)
	return nil
}

// startHTTP builds the main server and registers the ordered graceful shutdown:
// the http step (ACME, then in-flight handlers, within httpDrainBudget), then
// hub-notice. It starts last so shutdown is the first thing the reverse walk
// does: in-flight broadcasts must still reach a live hub and persister, or the
// frames vanish from the replay store across the restart.
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
	// failing before serve() would leave the port bound.
	a.onClose("listener", func(context.Context) error {
		if a.ln != nil {
			_ = a.ln.Close()
		}
		return nil
	})
	// Own step so the notice window keeps its budget however long the drain took; "hub" only joins.
	a.onClose("hub-notice", func(ctx context.Context) error {
		a.hub.GracefulStopContext(ctx, a.deps.Restart.noticeReason())
		return nil
	})
	a.onCloseWithin("http", httpDrainBudget, func(ctx context.Context) error {
		return shutdownServers(ctx, a.log, a.srv, a.acmeSrv)
	})
	// An open admin log stream never returns and Shutdown waits for every
	// handler, so end the streams as Shutdown begins.
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

// startSignals arms the shutdown context under the coordinator's context, so a
// programmatic restart drains like a SIGTERM, including on Windows.
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

// OpenLinkPreviews opens the link preview store under server.data_dir, logging a failure once
// and returning nil so callers degrade rather than stop. Build one and share it: its mutex
// orders a thumbnail write against the sweep.
func OpenLinkPreviews(log *slog.Logger, cfg *config.Config, database linkpreview.Repo) *linkpreview.Store {
	if cfg.Server.DataDir == "" {
		return nil
	}
	store, err := linkpreview.NewStore(database, filepath.Join(cfg.Server.DataDir, linkpreview.DirName))
	if err != nil {
		log.Warn("failed to open link preview store; thumbnail sweep disabled", "error", err)
		return nil
	}
	return store
}
