// OwnCord chat server — self-hosted, Windows-native.
// Build: go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/owncord/server/api"
	"github.com/owncord/server/auth"
	"github.com/owncord/server/config"
	"github.com/owncord/server/db"
)

// version is overridden at build time via -ldflags "-X main.version=1.0.0".
var version = "dev"

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))

	if err := run(log); err != nil {
		log.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}

// run is the real entrypoint — separated for testability.
func run(log *slog.Logger) error {
	// Clean up old binary from a previous update.
	if exePath, err := os.Executable(); err == nil {
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
	log.Info("configuration loaded",
		"server_name", cfg.Server.Name,
		"port", cfg.Server.Port,
		"tls_mode", cfg.TLS.Mode,
	)

	// ── 2. Ensure data directory exists ────────────────────────────────────
	if mkdirErr := os.MkdirAll(cfg.Server.DataDir, 0o755); mkdirErr != nil {
		return fmt.Errorf("creating data dir %s: %w", cfg.Server.DataDir, mkdirErr)
	}

	// ── 3. Open database + run migrations ─────────────────────────────────
	database, err := db.Open(cfg.Database.Path)
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer database.Close()

	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	log.Info("database ready", "path", cfg.Database.Path)

	// ── 4. TLS ─────────────────────────────────────────────────────────────
	tlsCfg, err := auth.LoadOrGenerate(cfg.TLS)
	if err != nil {
		return fmt.Errorf("configuring TLS: %w", err)
	}

	// ── 5. Build HTTP router ───────────────────────────────────────────────
	router := api.NewRouter(cfg, database, version)

	// ── 6. Start server ────────────────────────────────────────────────────
	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      router,
		TLSConfig:    tlsCfg,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Listen for OS signals for graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Start serving in a goroutine.
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server starting", "addr", addr, "tls", tlsCfg != nil, "version", version)

		var listenErr error
		for attempt := 0; attempt < 20; attempt++ {
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
		if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
			serveErr <- listenErr
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

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}

	log.Info("server stopped cleanly")
	return nil
}

// isAddrInUse checks if an error is an "address already in use" error.
func isAddrInUse(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "address already in use") || strings.Contains(err.Error(), "Only one usage of each socket address"))
}

