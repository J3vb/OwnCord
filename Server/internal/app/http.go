package app

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/ws"
)

// startACMEServer starts the ACME HTTP-01 challenge server when Let's Encrypt
// is configured, and returns nil otherwise. The acme stage; the http stage
// below owns shutting both servers down, in the order the drain requires.
func startACMEServer(log *slog.Logger, httpHandler http.Handler) *http.Server {
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

// serveAndWait starts the listener and blocks until it fails or a
// shutdown or restart signal arrives. App.serve calls it after every stage
// is up.
func serveAndWait(ctx context.Context, log *slog.Logger, rc *RestartCoordinator, srv *http.Server, tlsCfg *tls.Config, addr, version string) error {
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

// shutdownServers performs the ordered graceful shutdown: the ACME
// server, then in-flight HTTP handlers, then the WebSocket hub. Extracted
// from run.
func shutdownServers(shutdownCtx context.Context, log *slog.Logger, srv, acmeSrv *http.Server, hub *ws.Hub) error {
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
