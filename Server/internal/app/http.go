package app

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"
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

// serveAndWait serves on the bound listener and blocks until it fails or a
// shutdown or restart signal arrives. App.serve calls it after every stage
// is up.
func serveAndWait(ctx context.Context, log *slog.Logger, rc *RestartCoordinator, srv *http.Server, ln net.Listener, tlsCfg *tls.Config, addr, version string) error {
	// Start serving in a goroutine.
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server starting", "addr", addr, "tls", tlsCfg != nil, "version", version)

		var err error
		if tlsCfg != nil {
			err = srv.ServeTLS(ln, "", "")
		} else {
			err = srv.Serve(ln)
		}
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
			log.Info("restart requested, draining connections (up to 30s for HTTP, 10s per other shutdown step)", "reason", reason)
		} else {
			log.Info("shutdown signal received, draining connections (up to 30s for HTTP, 10s per other shutdown step)")
		}
	}

	return nil
}

// shutdownServers drains the ACME server, then in-flight HTTP handlers. The
// hub stops in the next close step ("hub-notice"), so in-flight handlers'
// broadcasts still reach a live hub (and the event persister) or the frames
// would vanish from the replay/event store across the restart. Shutdown does
// not wait on hijacked WebSocket connections, so connected clients do not
// delay the drain — they get the restart notice right after it.
func shutdownServers(shutdownCtx context.Context, log *slog.Logger, srv, acmeSrv *http.Server) error {
	if acmeSrv != nil {
		if err := acmeSrv.Shutdown(shutdownCtx); err != nil {
			log.Warn("ACME HTTP server shutdown error", "error", err)
		}
	}

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}
