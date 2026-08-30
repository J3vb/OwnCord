// Package app owns the server process lifecycle: it opens and migrates the
// database, starts telemetry, plugins, the HTTP router and hub, event
// persistence, the audit writer, ACME and the maintenance workers, serves
// until a shutdown or restart signal, and tears every stage back down. main
// keeps only the CLI dispatch, the log sinks and the restart handoff (B3-3).
package app

import (
	"context"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/auth"
)

// Run is the server's real entrypoint — separated from main() for
// testability. rc carries a self-restart request out to main(), which
// performs the actual handoff once everything here has drained (see
// restart.go). version is main's -ldflags-injected build version.
func Run(version string, log *slog.Logger, logBuf *admin.RingBuffer, levelVar *slog.LevelVar, rc *RestartCoordinator) error {
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

	if err := runServeAndWait(ctx, log, rc, srv, tlsCfg, addr, version); err != nil {
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
