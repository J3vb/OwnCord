// OwnCord chat server — self-hosted, Windows-native.
// Build: go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	stdlog "log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
	"github.com/owncord/server/plugin"
	"github.com/owncord/server/storage"
	"github.com/owncord/server/store"
	"github.com/owncord/server/telemetry"
	"github.com/owncord/server/ws"
)

// version is overridden at build time via -ldflags "-X main.version=1.0.0".
var version = "dev"

func main() {
	// Create ring buffer for admin log viewer, then build a multi-handler
	// that tees log records to both stdout (INFO+) and the ring buffer (DEBUG+).
	logBuf := admin.NewRingBuffer(2000)
	stdoutHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	multiHandler := admin.NewMultiHandler(stdoutHandler, logBuf, slog.LevelDebug)
	log := slog.New(multiHandler)
	slog.SetDefault(log)

	if err := run(log, logBuf); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "\n  [ERROR] %v\n\n", err)
		log.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

// run is the real entrypoint — separated for testability.
func run(log *slog.Logger, logBuf *admin.RingBuffer) error {
	// Clean up old binary from a previous update.
	exePath, exeErr := os.Executable()
	if exeErr != nil {
		log.Warn("failed to determine executable path", "error", exeErr)
	} else {
		oldPath := exePath + ".old"
		if _, statErr := os.Stat(oldPath); statErr == nil {
			if rmErr := os.Remove(oldPath); rmErr != nil {
				log.Warn("failed to remove old binary", "path", oldPath, "error", rmErr)
			} else {
				log.Info("removed old binary from previous update", "path", oldPath)
			}
		}
	}

	// ── 1. Load configuration ──────────────────────────────────────────────
	cfg, err := config.Load("config.yaml")
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}

	// ── 2. Ensure data directory exists ────────────────────────────────────
	if mkdirErr := os.MkdirAll(cfg.Server.DataDir, 0o750); mkdirErr != nil {
		return fmt.Errorf("creating data dir %s: %w", cfg.Server.DataDir, mkdirErr)
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
	// The Phase A plan calls for two backends (sqlite, postgres) selected via
	// config. SQLite is the only backend currently wired through the *db.DB
	// type. The PostgreSQL scaffolding is in place (schema under
	// Server/migrations/postgres, sqlc query files under
	// Server/db/queries/postgres, PostgresStore behind the `postgres` build
	// tag in Server/store/postgres.go), but PostgresStore's query methods
	// are still stubs and the handler boundary still passes *db.DB directly
	// rather than store.Store. Until both of those land, selecting
	// type: "postgres" refuses to start with a clear pointer at what's left.
	switch dbType := cfg.Database.Type; dbType {
	case "", "sqlite":
		// fall through to the existing SQLite path
	case "postgres":
		return fmt.Errorf("database.type=postgres is configured, but the postgres " +
			"backend is not yet wired into the runtime. PostgresStore exists at " +
			"Server/store/postgres.go behind the `postgres` build tag, with connection " +
			"lifecycle fully implemented but query methods stubbed. What's still " +
			"pending: (1) run `make sqlc-generate` to produce Server/db/pgdbgen/, " +
			"(2) replace the stub query methods in postgres.go with wrappers around " +
			"pgdbgen, and (3) refactor api/router.go and this main.go to thread " +
			"store.Store through the handler boundary instead of *db.DB. Until those " +
			"land, set database.type to \"sqlite\" or omit it to start the server")
	default:
		return fmt.Errorf("database.type=%q is not recognised; expected \"sqlite\" or \"postgres\"", dbType)
	}

	database, err := db.Open(cfg.Database.Path)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer database.Close() //nolint:errcheck

	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}

	// Clear stale state from a previous run or crash.
	if err := database.ResetAllUserStatuses(); err != nil {
		log.Warn("failed to reset stale user statuses", "error", err)
	} else {
		log.Info("reset all user statuses to offline")
	}
	if err := database.ClearAllVoiceStates(); err != nil {
		log.Warn("failed to clear stale voice states", "error", err)
	} else {
		log.Info("cleared stale voice states")
	}

	// ── 4b. Telemetry (Phase B Step 8) ─────────────────────────────────────
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
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := telemetryShutdown(shutdownCtx); err != nil {
			log.Warn("telemetry shutdown returned error", "error", err)
		}
	}()

	// ── 5. Construct shared store wrapper ──────────────────────────────────
	// Used by both the event persistence layer and the plugin runtime. Once
	// the Phase A "store everywhere" refactor lands, NewRouter will accept
	// store.Store directly and this wrapper goes away.
	storeWrapper := store.NewSQLiteStore(database)

	// ── 5a. Construct plugin runtime BEFORE the router so the router can
	// wire the live registry into the plugin admin handler. ────────────────
	var pluginRegistry *plugin.Registry
	if cfg.Plugins.Enabled {
		registry, plugErr := plugin.NewRegistry(plugin.Config{
			Directory:     cfg.Plugins.Directory,
			MaxMemoryMB:   cfg.Plugins.MaxMemoryMB,
			CPUBudgetMs:   cfg.Plugins.CPUBudgetMs,
			HTTPAllowlist: cfg.Plugins.HTTPAllowlist,
			Store:         storeWrapper,
		})
		if plugErr != nil {
			log.Warn("plugin runtime init failed; continuing without plugins", "error", plugErr)
		} else {
			pluginRegistry = registry
			if err := registry.LoadAll(context.Background()); err != nil {
				log.Warn("plugin loader: failed to scan directory", "error", err)
			}
			defer func() {
				closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = registry.Close(closeCtx)
			}()
		}
	}

	// ── 5b. Build HTTP router ──────────────────────────────────────────────
	router, hub, routerCleanup := api.NewRouter(cfg, database, version, logBuf, pluginRegistry)
	defer routerCleanup()

	// ── 5c. Wire event persistence (Phase B Step 7) ────────────────────────
	if cfg.EventPersistence.Enabled && hub != nil {
		// Seed the hub's in-memory seq counter from the persisted MAX(seq)
		// so wrapped-payload seqs stay monotonic across restarts. Without
		// this, the events table accumulates rows whose payload seqs reset
		// to 1 after every restart, breaking the reconnect "events since
		// last_seq" contract.
		if maxSeq, seedErr := storeWrapper.GetMaxEventSeq(context.Background()); seedErr != nil {
			log.Warn("event persistence: failed to read MAX(events.seq); starting hub seq from 0", "error", seedErr)
		} else if maxSeq > 0 {
			hub.SeedSeq(uint64(maxSeq))
			log.Info("event persistence: seeded hub seq from persisted events", "seq", maxSeq)
		}

		persister := ws.NewEventPersister(
			storeWrapper,
			4096,
			cfg.EventPersistence.BatchSize,
			time.Duration(cfg.EventPersistence.BatchFlushMs)*time.Millisecond,
		)
		persister.Start(context.Background())
		hub.SetEventPersister(persister)
		hub.SetEventStore(storeWrapper)

		retention := time.Duration(cfg.EventPersistence.RetentionHours) * time.Hour
		prunerInterval := time.Duration(cfg.EventPersistence.PrunerIntervalMinutes) * time.Minute
		prunerCtx, prunerCancel := context.WithCancel(context.Background())
		ws.StartEventPruner(prunerCtx, storeWrapper, retention, prunerInterval)
		defer func() {
			prunerCancel()
			stopCtx, stopCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer stopCancel()
			persister.Stop(stopCtx)
		}()
	}

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
	var acmeSrv *http.Server
	if tlsResult.HTTPHandler != nil {
		acmeSrv = &http.Server{
			Addr:         ":80",
			Handler:      tlsResult.HTTPHandler,
			ReadTimeout:  10 * time.Second,
			WriteTimeout: 10 * time.Second,
		}
		go func() {
			log.Info("ACME HTTP challenge server starting on :80")
			if err := acmeSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("ACME HTTP server error", "error", err)
			}
		}()
	}

	// ── 7. Background maintenance ────────────────────────────────────────
	// Periodically purge expired sessions and orphaned attachments.
	fileStorage, fileStorageErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if fileStorageErr != nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled", "error", fileStorageErr)
	}

	stopMaintenance := make(chan struct{})
	go func() {
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

				tickFailed := false
				if err := database.DeleteExpiredSessions(); err != nil {
					log.Warn("failed to delete expired sessions", "error", err)
					tickFailed = true
				}

				// Clean up orphaned attachments (uploaded but never linked to a message).
				cutoff := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
				orphanFiles, orphanErr := database.DeleteOrphanedAttachments(cutoff)
				if orphanErr != nil {
					log.Warn("failed to delete orphaned attachments", "error", orphanErr)
					tickFailed = true
				} else if len(orphanFiles) > 0 {
					// Best-effort file cleanup.
					if fileStorage != nil {
						for _, filename := range orphanFiles {
							if delErr := fileStorage.Delete(filename); delErr != nil {
								log.Warn("failed to delete orphan file", "file", filename, "error", delErr)
							}
						}
					}
					log.Info("cleaned up orphaned attachments", "count", len(orphanFiles))
				}

				if tickFailed {
					consecutiveFailures++
				} else {
					consecutiveFailures = 0
				}
			case <-stopMaintenance:
				return
			}
		}
	}()

	// Listen for OS signals for graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Start serving in a goroutine.
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server starting", "addr", addr, "tls", tlsCfg != nil, "version", version)

		for attempt := 0; attempt < 20; attempt++ {
			var listenErr error
			if tlsCfg != nil {
				listenErr = srv.ListenAndServeTLS("", "")
			} else {
				listenErr = srv.ListenAndServe()
			}
			if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
				// Check if it's an "address already in use" error (port not released yet from old process)
				if attempt < 19 && isAddrInUse(listenErr) {
					log.Warn("port in use, retrying...", "attempt", attempt+1, "error", listenErr)
					time.Sleep(500 * time.Millisecond)
					continue
				}
				serveErr <- listenErr
			}
			break
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
		log.Info("shutdown signal received, draining connections (30s timeout)")
	}

	// Graceful shutdown.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if acmeSrv != nil {
		if err := acmeSrv.Shutdown(shutdownCtx); err != nil {
			log.Warn("ACME HTTP server shutdown error", "error", err)
		}
	}

	// Stop the WebSocket hub: close all PeerConnections, voice rooms, and
	// notify connected clients before draining HTTP connections.
	hub.GracefulStop()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}

	close(stopMaintenance)
	log.Info("server stopped cleanly")
	return nil
}

// isAddrInUse checks if an error is an "address already in use" error.
func isAddrInUse(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "address already in use") || strings.Contains(err.Error(), "Only one usage of each socket address"))
}

// printBanner writes the startup banner to stderr (so it doesn't mix with
// JSON-structured log output on stdout).
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
