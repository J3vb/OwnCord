// OwnCord chat server — self-hosted, Windows-native.
// Build: go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/diskutil"
	"github.com/owncord/server/logctx"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/storage"
	"github.com/owncord/server/telemetry"
	"github.com/owncord/server/ws"
)

// version is overridden at build time via -ldflags "-X main.version=1.0.0".
var version = "dev"

func main() {
	// `server healthcheck` probes the running instance's /health and exits
	// 0/1. It exists for container healthchecks: the distroless image has no
	// shell or curl, so the binary is its own probe.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheckCLI())
	}
	// `server token ...` is a direct-to-DB CLI (mint/list/revoke API tokens) —
	// handled before any server/logging setup so it stays quiet and standalone.
	if len(os.Args) > 1 && os.Args[1] == "token" {
		os.Exit(runTokenCLI(os.Args[2:]))
	}

	// Create ring buffer for admin log viewer, then build a multi-handler
	// that tees log records to both stdout and the ring buffer.
	logBuf := admin.NewRingBuffer(2000)
	// levelVar controls both handlers' thresholds. It starts at INFO (the
	// zero value) so early-startup logs are captured, then run() raises/lowers
	// it once config.yaml / OWNCORD_LOGGING_LEVEL is loaded. The ring buffer
	// shares it rather than hard-wiring DEBUG: with both sinks gated, Enabled
	// returns false for suppressed levels and every gated Debug call across
	// the server becomes a no-op instead of formatting a ring entry.
	levelVar := new(slog.LevelVar)
	stdoutHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: levelVar})
	multiHandler := admin.NewMultiHandler(stdoutHandler, logBuf, levelVar)
	// logctx enriches records logged with a request/trace context (the
	// ...Context slog variants) with req_id and, under -tags otel, trace_id.
	log := slog.New(logctx.New(multiHandler))
	slog.SetDefault(log)

	// The restart coordinator carries a self-restart request (update apply,
	// backup restore, setup wizard) across run()'s teardown — see restart.go.
	// The backstop closure fires only if a requested restart's drain wedges
	// past restartBackstopDelay: it performs the handoff and force-exits,
	// mirroring what the code below does on the healthy path.
	var rc *restartCoordinator
	rc = newRestartCoordinator(restartBackstopDelay, func() {
		slog.Error("restart backstop fired — teardown exceeded its budget, exiting for handoff")
		reason, _ := rc.Requested()
		performRestartHandoff(reason, rc.Mode(), slog.Default())
		os.Exit(0)
	})

	err := run(log, logBuf, levelVar, rc)
	rc.disarm()

	// Perform the handoff even when run() returned an error: a restart is
	// only ever requested after a committed binary swap or a restore that
	// closed the database, so not restarting is strictly worse than
	// restarting into whatever the error was.
	if reason, ok := rc.Requested(); ok {
		performRestartHandoff(reason, rc.Mode(), log)
	}

	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "\n  [ERROR] %v\n\n", err)
		log.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

// run is the real entrypoint — separated for testability. rc carries a
// self-restart request out to main(), which performs the actual handoff once
// everything here has drained (see restart.go).
func run(log *slog.Logger, logBuf *admin.RingBuffer, levelVar *slog.LevelVar, rc *restartCoordinator) error {
	// bgCtx is a cancellable context shared by all background goroutines
	// (event persister, event pruner, plugin loader, maintenance loop).
	//
	// This first deferred bgCancel is only the LIFO backstop — because it is
	// registered before `defer database.Close()`, it would otherwise run
	// AFTER the database is closed, leaving background goroutines running
	// through teardown. The persistence and maintenance blocks below register
	// their own later (= earlier-running) defers that cancel bgCtx and JOIN
	// their goroutines before the database closes.
	bgCtx, bgCancel := context.WithCancel(context.Background())
	defer bgCancel()

	runRemoveOldBinary(log)

	// ── 1. Load configuration ──────────────────────────────────────────────
	cfg, err := runLoadConfig(log, levelVar, rc)
	if err != nil {
		return err
	}

	// ── 2. Ensure data directory exists ────────────────────────────────────
	if err := runPrepareDataDir(log, cfg); err != nil {
		return err
	}

	// ── 3. TLS ────────────────────────────────────────────────────────────
	tlsResult, err := auth.LoadOrGenerate(cfg.TLS)
	if err != nil {
		return fmt.Errorf("configuring TLS: %w", err)
	}
	tlsCfg := tlsResult.TLSConfig

	// Print startup banner first so it appears above all init logs.
	printBanner(cfg, version, tlsCfg != nil)

	// ── 4. Open database + run migrations ─────────────────────────────────
	database, err := runOpenDatabase(cfg)
	if err != nil {
		return err
	}
	defer database.Close() //nolint:errcheck

	if err := runInitDatabase(log, cfg, database, rc); err != nil {
		return err
	}

	// ── 4b. Telemetry (Phase B Step 8) ─────────────────────────────────────
	telemetryStop := runInitTelemetry(log, cfg)
	defer telemetryStop()

	// ── 5a. Construct plugin runtime BEFORE the router so the router can
	// wire the live registry into the plugin admin handler. ────────────────
	pluginRegistry := runInitPlugins(bgCtx, log, cfg, database)
	defer runClosePlugins(pluginRegistry)

	// ── 5b. Build HTTP router ──────────────────────────────────────────────
	router, hub, routerCleanup := api.NewRouter(cfg, database, version, logBuf, pluginRegistry)
	defer routerCleanup()
	// Backstop for every early return below (serve error, ACME shutdown
	// failure, etc.): hub.GracefulStop is the only caller of
	// LiveKitProcess.Stop(), so skipping it orphans the companion
	// livekit-server process and leaves the hub's dispatch goroutine
	// running. gracefulOnce makes it idempotent alongside the explicit call
	// on the normal shutdown path below.
	defer hub.GracefulStop()

	// ── 5c. Wire event persistence (Phase B Step 7) ────────────────────────
	persister, prunerDone := runStartEventPersistence(bgCtx, log, cfg, hub, database)
	defer runStopEventPersistence(log, bgCancel, persister, prunerDone)

	// ── 5d. Async audit writer ─────────────────────────────────────────────
	// Moves audit-log INSERTs off the request path: once the writer is
	// installed, WriteAudit enqueues here and a background goroutine batches
	// the writes (same shape as the event persister above). Paths that never
	// install a writer — the token CLI, tests — keep the synchronous
	// behavior. This defer is registered after `defer database.Close()` so
	// LIFO ordering drains the queue before the database is torn down.
	auditWriter := runStartAuditWriter(bgCtx, database)
	defer runStopAuditWriter(auditWriter)

	// ── 6. Start server ────────────────────────────────────────────────────
	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		TLSConfig:    tlsCfg,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
		ErrorLog:     stdlog.New(io.Discard, "", 0), // suppress TLS handshake noise
	}

	// ── 6b. ACME HTTP challenge server on :80 ─────────────────────────────
	// When using Let's Encrypt (tls.mode: acme), an HTTP server on port 80
	// is needed for HTTP-01 challenge validation and HTTP→HTTPS redirect.
	acmeSrv := runStartACME(log, tlsResult.HTTPHandler)

	// ── 7. Background maintenance ────────────────────────────────────────
	maintenanceStop := runStartMaintenance(bgCtx, log, cfg, database)
	defer maintenanceStop()

	// Listen for OS signals for graceful shutdown. The coordinator's context
	// is the parent, so a programmatic restart request (rc.Request) drains
	// exactly like a SIGTERM — including on Windows, where a process cannot
	// signal itself. Signals arriving mid-drain are swallowed until stop()
	// runs, same as on the real-signal path.
	ctx, stop := signal.NotifyContext(rc.Context(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := runServeAndWait(ctx, log, rc, srv, tlsCfg, addr); err != nil {
		return err
	}

	// Graceful shutdown.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := runShutdownServers(shutdownCtx, log, srv, acmeSrv, hub); err != nil {
		return err
	}

	log.Info("server stopped cleanly")
	return nil
}

// runRemoveOldBinary deletes the binary a previous self-update left behind.
// Extracted from run.
func runRemoveOldBinary(log *slog.Logger) {
	// Clean up old binary from a previous update. Bounded retry: in spawn
	// mode the predecessor spawns this process as its very last act, so for
	// the first few hundred milliseconds it may not have fully exited — and
	// on Windows its image file (the .old after the swap) stays locked until
	// it does.
	exePath, exeErr := os.Executable()
	if exeErr != nil {
		log.Warn("failed to determine executable path", "error", exeErr)
		return
	}

	oldPath := exePath + ".old"
	if _, statErr := os.Stat(oldPath); statErr != nil {
		return
	}

	var rmErr error
	for attempt := range 5 {
		if attempt > 0 {
			time.Sleep(250 * time.Millisecond)
		}
		if rmErr = os.Remove(oldPath); rmErr == nil {
			break
		}
	}
	if rmErr != nil {
		log.Warn("failed to remove old binary", "path", oldPath, "error", rmErr)
	} else {
		log.Info("removed old binary from previous update", "path", oldPath)
	}
}

// runLoadConfig loads the on-disk configuration, applies its logging level
// and resolves the restart handoff mode. Extracted from run.
func runLoadConfig(log *slog.Logger, levelVar *slog.LevelVar, rc *restartCoordinator) (*config.Config, error) {
	cfg, err := config.Load(config.DefaultPath)
	if err != nil {
		return nil, fmt.Errorf("loading config: %w", err)
	}

	// Apply the configured log level. The admin panel's live log view (ring
	// buffer) follows the same threshold — set logging.level to "debug" to
	// capture debug records there.
	if lvl, ok := config.ParseLevel(cfg.Logging.Level); ok {
		levelVar.Set(lvl)
	} else {
		log.Warn("unknown logging.level, keeping info", "value", cfg.Logging.Level)
	}

	// Resolve how a self-restart hands off (spawn the replacement vs exit
	// for a supervisor) now that config is loaded — main() reads it back
	// after run() returns.
	rc.SetMode(resolveRestartMode(cfg.Server.RestartMode, log))

	return cfg, nil
}

// runPrepareDataDir creates the configured data directory and warns when the
// volumes the server writes to are low on free space. Extracted from run.
func runPrepareDataDir(log *slog.Logger, cfg *config.Config) error {
	if mkdirErr := os.MkdirAll(cfg.Server.DataDir, 0o750); mkdirErr != nil {
		return fmt.Errorf("creating data dir %s: %w", cfg.Server.DataDir, mkdirErr)
	}

	// Disk-space awareness: the database (WAL growth included), uploads,
	// certs, and by default backups all live on this volume, and running it
	// dry breaks several of them at once. Probe errors are ignored — unknown
	// is not "full". /health repeats this check continuously at 256 MiB.
	warnLowDisk(log, "data dir", cfg.Server.DataDir)
	if cfg.Backup.Dir != "" && cfg.Backup.Dir != filepath.Join(cfg.Server.DataDir, "backups") {
		warnLowDisk(log, "backup dir", cfg.Backup.Dir)
	}

	return nil
}

// runOpenDatabase validates the configured backend and opens the database.
// Extracted from run.
func runOpenDatabase(cfg *config.Config) (*db.DB, error) {
	// SQLite is the only supported backend; the unfinished Postgres
	// scaffolding (stubbed query layer, never wired into the runtime) was
	// removed rather than completed.
	if t := cfg.Database.Type; t != "" && t != "sqlite" {
		return nil, fmt.Errorf("database.type=%q is not supported; set \"sqlite\" or omit it", t)
	}

	database, err := db.OpenWithMaxReaders(cfg.Database.Path, cfg.Database.MaxReaders)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	return database, nil
}

// runInitDatabase points the admin panel at the live database, runs the
// migrations and clears state left over from a previous run. Extracted from
// run.
func runInitDatabase(log *slog.Logger, cfg *config.Config, database *db.DB, rc *restartCoordinator) error {
	// The admin "Restore backup" handler needs the real database file path:
	// without this, it falls back to a hardcoded "data/chatserver.db" and
	// silently no-ops on any server with a configured database.path.
	admin.SetDatabasePath(cfg.Database.Path)
	// Backup handlers and the scheduled-backup maintenance write to the
	// configured backup directory (defaults to data/backups).
	admin.SetBackupDir(cfg.Backup.Dir)
	// Admin restart requests (update apply, backup restore, setup wizard)
	// land in the coordinator, which drains this process and lets main()
	// perform the handoff. Wired before the listener starts serving, so no
	// admin request can ever hit the unwired default hook.
	admin.SetRestartHandoff(rc.Request)

	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}

	// Clear stale state from a previous run or crash. Startup work — nothing
	// to inherit a context from yet.
	if err := database.ResetAllUserStatuses(context.Background()); err != nil {
		log.Warn("failed to reset stale user statuses", "error", err)
	} else {
		log.Info("reset all user statuses to offline")
	}
	if err := database.ClearAllVoiceStates(context.Background()); err != nil {
		log.Warn("failed to clear stale voice states", "error", err)
	} else {
		log.Info("cleared stale voice states")
	}

	return nil
}

// runInitTelemetry initialises OpenTelemetry and returns the shutdown step
// run defers. Extracted from run.
func runInitTelemetry(log *slog.Logger, cfg *config.Config) func() {
	// Init can return (nil, err) when the otel build-tag skeleton hasn't been
	// finished wiring to the upstream SDK. Normalise to a no-op shutdown so
	// the deferred closure never calls a nil function.
	telemetryShutdown, telErr := telemetry.Init(context.Background(), cfg.Telemetry)
	if telErr != nil {
		log.Warn("telemetry init failed; continuing without OpenTelemetry", "error", telErr)
	}
	if telemetryShutdown == nil {
		telemetryShutdown = func(context.Context) error { return nil }
	}

	return func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := telemetryShutdown(shutdownCtx); err != nil {
			log.Warn("telemetry shutdown returned error", "error", err)
		}
	}
}

// runInitPlugins constructs the plugin runtime, returning nil when plugins
// are disabled or failed to start. Extracted from run.
func runInitPlugins(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) *plugin.Registry {
	var pluginRegistry *plugin.Registry
	if cfg.Plugins.Enabled {
		registry, plugErr := plugin.NewRegistry(plugin.Config{
			Directory:     cfg.Plugins.Directory,
			MaxMemoryMB:   cfg.Plugins.MaxMemoryMB,
			CPUBudgetMs:   cfg.Plugins.CPUBudgetMs,
			HTTPAllowlist: cfg.Plugins.HTTPAllowlist,
			Store:         database,
		})
		if plugErr != nil {
			log.Warn("plugin runtime init failed; continuing without plugins", "error", plugErr)
		} else {
			pluginRegistry = registry
			if err := registry.LoadAll(bgCtx); err != nil {
				log.Warn("plugin loader: failed to scan directory", "error", err)
			}
		}
	}

	return pluginRegistry
}

// runClosePlugins shuts the plugin runtime down. Registered by run as a defer
// only once the registry exists, so a nil registry is the disabled case and
// has nothing to close. Extracted from run.
func runClosePlugins(registry *plugin.Registry) {
	if registry == nil {
		return
	}

	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = registry.Close(closeCtx)
}

// runStartEventPersistence starts the event persister and pruner, returning
// both as (nil, nil) when event persistence is disabled. Extracted from run.
func runStartEventPersistence(bgCtx context.Context, log *slog.Logger, cfg *config.Config, hub *ws.Hub, database *db.DB) (*ws.EventPersister, <-chan struct{}) {
	if !cfg.EventPersistence.Enabled || hub == nil {
		return nil, nil
	}

	seedHubReplayState(bgCtx, hub, database, log)

	persister := ws.NewEventPersister(
		database,
		4096,
		cfg.EventPersistence.BatchSize,
		time.Duration(cfg.EventPersistence.BatchFlushMs)*time.Millisecond,
	)
	persister.Start(bgCtx)
	hub.SetEventPersister(persister)
	hub.SetEventStore(database)

	retention := time.Duration(cfg.EventPersistence.RetentionHours) * time.Hour
	prunerInterval := time.Duration(cfg.EventPersistence.PrunerIntervalMinutes) * time.Minute
	prunerDone := ws.StartEventPruner(bgCtx, database, retention, prunerInterval)

	return persister, prunerDone
}

// runStopEventPersistence drains the event persister and pruner. Registered by
// run as a defer unconditionally, so a nil persister is the disabled case and
// must leave bgCtx alone — the LIFO backstop in run cancels it instead.
// Extracted from run.
func runStopEventPersistence(log *slog.Logger, bgCancel context.CancelFunc, persister *ws.EventPersister, prunerDone <-chan struct{}) {
	if persister == nil {
		return
	}

	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	persister.Stop(stopCtx)
	// Cancel the shared background context and JOIN the pruner before
	// the (LIFO-later) database.Close defer runs, so no prune is still
	// mid-query against a closing pool. Bounded: a stuck prune delays
	// shutdown by at most the timeout, then Close proceeds anyway.
	bgCancel()
	select {
	case <-prunerDone:
	case <-stopCtx.Done():
		log.Warn("event pruner did not exit before shutdown timeout")
	}
}

// runStartAuditWriter installs the async audit writer. Extracted from run.
func runStartAuditWriter(bgCtx context.Context, database *db.DB) *db.AuditWriter {
	auditWriter := db.NewAuditWriter(database, 1024, 50, 100*time.Millisecond)
	auditWriter.Start(bgCtx)
	database.SetAuditWriter(auditWriter)

	return auditWriter
}

// runStopAuditWriter drains the async audit writer. Extracted from run.
func runStopAuditWriter(auditWriter *db.AuditWriter) {
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopCancel()
	auditWriter.Stop(stopCtx)
}

// runStartACME starts the ACME HTTP-01 challenge server when Let's Encrypt
// is configured, and returns nil otherwise. Extracted from run.
func runStartACME(log *slog.Logger, httpHandler http.Handler) *http.Server {
	var acmeSrv *http.Server
	if httpHandler != nil {
		acmeSrv = &http.Server{
			Addr:         ":80",
			Handler:      httpHandler,
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 10 * time.Second,
		}
		go func() {
			log.Info("ACME HTTP challenge server starting on :80")
			if err := serveWithBindRetry(log, "acme-http", acmeSrv.ListenAndServe); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("ACME HTTP server error — HTTP-01 challenges and certificate renewal will fail until the next restart", "error", err)
			}
		}()
	}

	return acmeSrv
}

// runStartMaintenance starts the periodic maintenance loop and returns the
// stop step run defers. Extracted from run.
func runStartMaintenance(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) func() {
	// Periodically purge expired sessions and orphaned attachments.
	fileStorage, fileStorageErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if fileStorageErr != nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled", "error", fileStorageErr)
	}

	stopMaintenance := make(chan struct{})
	maintenanceDone := make(chan struct{})
	go runMaintenanceLoop(bgCtx, log, database, fileStorage, stopMaintenance, maintenanceDone)

	return func() {
		// Backstop for early returns below (see hub.GracefulStop defer above),
		// and a bounded join so an in-flight tick (which can hold the writer —
		// scheduled backups run VACUUM INTO) isn't still using the database
		// while the LIFO-later Close defer tears it down.
		close(stopMaintenance)
		select {
		case <-maintenanceDone:
		case <-time.After(5 * time.Second):
			log.Warn("maintenance loop did not exit before shutdown timeout")
		}
	}
}

// runMaintenanceLoop is the periodic maintenance goroutine started by
// runStartMaintenance. Extracted from run.
func runMaintenanceLoop(bgCtx context.Context, log *slog.Logger, database *db.DB, fileStorage *storage.Storage, stopMaintenance, maintenanceDone chan struct{}) {
	defer close(maintenanceDone)
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	consecutiveFailures := 0
	const maxConsecutiveFailures = 5
	for {
		select {
		case <-ticker.C:
			if consecutiveFailures >= maxConsecutiveFailures {
				log.Error("maintenance loop: circuit breaker open, skipping tick",
					"consecutive_failures", consecutiveFailures)
				// Reset after one skip to allow retry next tick.
				consecutiveFailures = maxConsecutiveFailures - 1
				continue
			}

			if runMaintenanceTick(bgCtx, log, database, fileStorage) {
				consecutiveFailures++
			} else {
				consecutiveFailures = 0
			}
		case <-stopMaintenance:
			return
		}
	}
}

// runMaintenanceTick runs one maintenance pass and reports whether any step
// of it failed. Extracted from run.
func runMaintenanceTick(bgCtx context.Context, log *slog.Logger, database *db.DB, fileStorage *storage.Storage) bool {
	tickFailed := false
	if err := database.DeleteExpiredSessions(bgCtx); err != nil {
		log.Warn("failed to delete expired sessions", "error", err)
		tickFailed = true
	}

	// Scheduled backups + retention pruning, driven by the
	// backup_schedule / backup_retention admin settings.
	if err := admin.MaintainBackups(bgCtx, database); err != nil {
		log.Warn("backup maintenance failed", "error", err)
		tickFailed = true
	}

	// Clean up orphaned attachments (uploaded but never linked to a message).
	//
	// Skipped entirely with no file storage configured: the delete is
	// atomic (row goes the instant it's selected, by design — see
	// db/attachment_queries.go), so with fileStorage nil the returned
	// stored_as names — the only remaining handle on those blobs —
	// would just be discarded and the files stranded on disk with no
	// query left able to name them. Leaving the rows in place keeps
	// them reclaimable once storage is available again.
	if fileStorage != nil {
		cutoff := time.Now().Add(-1 * time.Hour)
		orphanFiles, orphanErr := database.DeleteOrphanedAttachments(bgCtx, cutoff)
		if orphanErr != nil {
			log.Warn("failed to delete orphaned attachments", "error", orphanErr)
			tickFailed = true
		} else if len(orphanFiles) > 0 {
			// Best-effort file cleanup.
			for _, filename := range orphanFiles {
				if delErr := fileStorage.Delete(filename); delErr != nil {
					log.Warn("failed to delete orphan file", "file", filename, "error", delErr)
				}
			}
			log.Info("cleaned up orphaned attachments", "count", len(orphanFiles))
		}
	}

	return tickFailed
}

// runServeAndWait starts the listener and blocks until it fails or a
// shutdown or restart signal arrives. Extracted from run.
func runServeAndWait(ctx context.Context, log *slog.Logger, rc *restartCoordinator, srv *http.Server, tlsCfg *tls.Config, addr string) error {
	// Start serving in a goroutine.
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server starting", "addr", addr, "tls", tlsCfg != nil, "version", version)

		err := serveWithBindRetry(log, "server", func() error {
			if tlsCfg != nil {
				return srv.ListenAndServeTLS("", "")
			}
			return srv.ListenAndServe()
		})
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
		close(serveErr)
	}()

	// Wait for shutdown signal or server error.
	select {
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("server error: %w", err)
		}
	case <-ctx.Done():
		if reason, ok := rc.Requested(); ok {
			log.Info("restart requested, draining connections (30s timeout)", "reason", reason)
		} else {
			log.Info("shutdown signal received, draining connections (30s timeout)")
		}
	}

	return nil
}

// runShutdownServers performs the ordered graceful shutdown: the ACME
// server, then in-flight HTTP handlers, then the WebSocket hub. Extracted
// from run.
func runShutdownServers(shutdownCtx context.Context, log *slog.Logger, srv, acmeSrv *http.Server, hub *ws.Hub) error {
	if acmeSrv != nil {
		if err := acmeSrv.Shutdown(shutdownCtx); err != nil {
			log.Warn("ACME HTTP server shutdown error", "error", err)
		}
	}

	// Drain in-flight HTTP handlers FIRST: their broadcasts must still reach
	// a live hub (and the event persister) or the frames vanish from the
	// replay/event store across the restart. Shutdown does not wait on
	// hijacked WebSocket connections, so the hub's own stop below is not
	// delayed by connected clients — they get the restart notice right after
	// the drain instead of right before it.
	shutdownErr := srv.Shutdown(shutdownCtx)

	// Stop the WebSocket hub: notify clients, stop LiveKit, close all client
	// connections. Threaded with the same 30s budget the operator was told
	// about — the notice sleep and LiveKit stop count against it rather than
	// extending it.
	hub.GracefulStopContext(shutdownCtx)

	if shutdownErr != nil {
		return fmt.Errorf("graceful shutdown: %w", shutdownErr)
	}

	return nil
}

// runHealthcheckCLI probes the local server's /health endpoint and returns a
// process exit code: 0 healthy, 1 degraded or unreachable. /health answers
// 503 with a subsystem reason when the hub, database, or disk is unhealthy,
// so a container orchestrator's healthcheck surfaces those too.
func runHealthcheckCLI() int {
	// Deliberately NOT config.Load: that writes a default config.yaml when
	// none exists, and a probe must have no side effects. Peek at the file
	// (and the env overrides) for just the values that shape the URL and the
	// certificate pin.
	port := 8443
	scheme := "https"
	certFile := "data/cert.pem"
	tlsMode := ""
	acmeDomain := ""
	if raw, err := os.ReadFile(config.DefaultPath); err == nil {
		var partial struct {
			Server struct {
				Port int `yaml:"port"`
			} `yaml:"server"`
			TLS struct {
				Mode     string `yaml:"mode"`
				CertFile string `yaml:"cert_file"`
				Domain   string `yaml:"domain"`
			} `yaml:"tls"`
		}
		if yaml.Unmarshal(raw, &partial) == nil {
			if partial.Server.Port > 0 {
				port = partial.Server.Port
			}
			tlsMode = partial.TLS.Mode
			if partial.TLS.Mode == "off" {
				scheme = "http"
			}
			if partial.TLS.CertFile != "" {
				certFile = partial.TLS.CertFile
			}
			acmeDomain = partial.TLS.Domain
		}
	}
	if env := os.Getenv("OWNCORD_SERVER_PORT"); env != "" {
		if p, err := strconv.Atoi(env); err == nil && p > 0 {
			port = p
		}
	}
	if env := os.Getenv("OWNCORD_TLS_MODE"); env != "" {
		tlsMode = env
		if env == "off" {
			scheme = "http"
		}
	}
	if env := os.Getenv("OWNCORD_TLS_DOMAIN"); env != "" {
		acmeDomain = env
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: healthcheckTLSConfig(tlsMode, certFile, acmeDomain),
		},
	}
	if port < 1 || port > 65535 {
		port = 8443
	}
	resp, err := client.Get(fmt.Sprintf("%s://127.0.0.1:%d/health", scheme, port)) //nolint:gosec // G704: host is hardcoded loopback; only the port comes from the operator's own config
	if err != nil {
		fmt.Fprintln(os.Stderr, "healthcheck: unreachable:", err)
		return 1
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		fmt.Fprintf(os.Stderr, "healthcheck: status %d: %s\n", resp.StatusCode, body)
		return 1
	}
	return 0
}

// healthcheckTLSConfig builds the probe's TLS config, per TLS mode:
//
//   - acme: the served cert is CA-issued for the configured domain, so
//     standard WebPKI verification works — but the probe dials 127.0.0.1, so
//     ServerName must be overridden to the domain or hostname verification
//     fails unconditionally and the probe reports a healthy server as down.
//     A stale pre-ACME data/cert.pem must NOT be pinned in this mode either;
//     the pin would mismatch the served ACME leaf forever.
//   - self_signed / manual: the cert can never pass WebPKI (the generated one
//     has no SANs and IsCA=false), so hostname/chain checks are replaced (not
//     skipped) by pinning: the presented leaf must be byte-identical to the
//     local cert file.
//   - anything else with no readable local cert: plain WebPKI.
func healthcheckTLSConfig(tlsMode, certFile, acmeDomain string) *tls.Config {
	if tlsMode == "acme" && acmeDomain != "" {
		return &tls.Config{MinVersion: tls.VersionTLS12, ServerName: acmeDomain}
	}
	pinned := loadPinnedCert(certFile)
	if pinned == nil {
		return &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		// Chain/hostname verification is replaced by the exact-match pin
		// below, which is strictly stronger for a cert we hold on disk.
		// VerifyConnection (not VerifyPeerCertificate) so the pin also runs
		// on resumed sessions (gosec G123).
		InsecureSkipVerify: true, //nolint:gosec // G402: VerifyConnection below pins the exact local certificate
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("healthcheck: server presented no certificate")
			}
			if !bytes.Equal(cs.PeerCertificates[0].Raw, pinned) {
				return errors.New("healthcheck: server certificate does not match " + certFile)
			}
			return nil
		},
	}
}

// loadPinnedCert reads the first PEM certificate block from path, returning
// its DER bytes, or nil when unavailable.
func loadPinnedCert(path string) []byte {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: path is the operator's own configured cert file
	if err != nil {
		return nil
	}
	block, _ := pem.Decode(raw)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil
	}
	return block.Bytes
}

// seedHubReplayState restores the hub's monotonic seq counter from the
// persisted MAX(events.seq) so wrapped-payload seqs stay monotonic across
// restarts. Without this, the events table accumulates rows whose payload
// seqs reset to 1 after every restart, breaking the reconnect "events since
// last_seq" contract.
//
// It also forces every client resuming from at or before that restored seq
// onto the full-ready path for this boot. h.seq is persisted and restored
// here, but the paired watermark that tells a resuming client whether a
// channel-visibility change happened since its last_seq
// (visibilityChangeSeq) is in-memory only and always starts at 0 on a fresh
// process — see ws/hub_events.go's mustFullResync. Channel-visibility
// changes made to an offline client (RefreshChannelVisibility,
// revokeUnreadableChannels) are sent as targeted, unsequenced messages that
// are never written to the events table, so replay can never recover them.
// Without the MarkVisibilityChanged call below, a client resuming with
// last_seq at or before the pre-restart max sails straight through
// mustFullResync's zeroed watermark and can silently miss a visibility
// change it should have converged on.
func seedHubReplayState(ctx context.Context, hub *ws.Hub, database *db.DB, log *slog.Logger) {
	maxSeq, seedErr := database.GetMaxEventSeq(ctx)
	if seedErr != nil {
		log.Warn("event persistence: failed to read MAX(events.seq); starting hub seq from 0", "error", seedErr)
		return
	}
	if maxSeq <= 0 {
		return
	}
	hub.SeedSeq(uint64(maxSeq))
	log.Info("event persistence: seeded hub seq from persisted events", "seq", maxSeq)
	hub.MarkVisibilityChanged()
}

// printBanner writes the startup banner to stderr (so it doesn't mix with
// the structured log output on stdout).
func printBanner(cfg *config.Config, ver string, tls bool) {
	scheme := "http"
	if tls {
		scheme = "https"
	}

	localIP := getOutboundIP()
	port := cfg.Server.Port
	baseURL := fmt.Sprintf("%s://%s:%d", scheme, localIP, port)
	adminURL := baseURL + "/admin"

	tlsStatus := "disabled"
	if tls {
		tlsStatus = "enabled"
	}

	banner := fmt.Sprintf(`

     ___                  ____              _
    / _ \__      ___ __  / ___|___  _ __ __| |
   | | | \ \ /\ / / '_ \| |   / _ \| '__/ _`+"`"+` |
   | |_| |\ V  V /| | | | |__| (_) | | | (_| |
    \___/  \_/\_/ |_| |_|\____\___/|_|  \__,_|

   ─────────────────────────────────────────────
    Server   %s
    Version  %s
    TLS      %s
    Platform %s/%s
   ─────────────────────────────────────────────
    API      %s/api/v1/info
    WebSocket   %s/api/v1/ws
    Admin    %s
    Health   %s/health
   ─────────────────────────────────────────────
    Press Ctrl+C to stop the server.

`, cfg.Server.Name, ver, tlsStatus, runtime.GOOS, runtime.GOARCH,
		baseURL, wsURL(scheme, localIP, port), adminURL, baseURL)

	_, _ = fmt.Fprint(os.Stderr, banner)
}

// wsURL builds the WebSocket URL with the correct scheme.
func wsURL(httpScheme, ip string, port int) string {
	ws := "ws"
	if httpScheme == "https" {
		ws = "wss"
	}
	return fmt.Sprintf("%s://%s:%d", ws, ip, port)
}

// Free-space thresholds for the boot-time disk warning. /health uses its own
// (lower) continuous threshold; these only shape startup log noise.
const (
	diskWarnBytes     = 1 << 30   // 1 GiB — warn
	diskCriticalBytes = 256 << 20 // 256 MiB — error
)

// warnLowDisk logs when the volume holding path is low on space. Probe
// failures (unsupported platform, missing dir) are silent — unknown ≠ full.
func warnLowDisk(log *slog.Logger, label, path string) {
	free, err := diskutil.FreeBytes(path)
	if err != nil {
		return
	}
	switch {
	case free < diskCriticalBytes:
		log.Error("disk space critically low — writes will start failing soon",
			"volume", label, "path", path, "free_mb", free>>20)
	case free < diskWarnBytes:
		log.Warn("disk space low", "volume", label, "path", path, "free_mb", free>>20)
	}
}

// getOutboundIP returns the preferred outbound IP of this machine by dialing
// a known external address (no actual connection is made with UDP).
func getOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "localhost"
	}
	defer conn.Close() //nolint:errcheck
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		slog.Warn("getOutboundIP: unexpected LocalAddr type, falling back to localhost",
			"type", fmt.Sprintf("%T", conn.LocalAddr()))
		return "localhost"
	}
	return addr.IP.String()
}
