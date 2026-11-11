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

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/api"
)

// startACMEServer starts the ACME HTTP-01 challenge server when Let's Encrypt
// is configured, else returns nil.
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
// shutdown or restart signal arrives.
func serveAndWait(ctx context.Context, log *slog.Logger, rc *RestartCoordinator, srv *http.Server, ln net.Listener, tlsCfg *tls.Config, addr, version string) error {
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

// shutdownServers drains the ACME server, then in-flight HTTP handlers. The hub
// stops in the next close step, so those handlers' broadcasts still reach a
// live hub and event persister; otherwise the frames would vanish from the
// replay store across the restart.
func shutdownServers(shutdownCtx context.Context, log *slog.Logger, srv, acmeSrv *http.Server) error {
	if acmeSrv != nil {
		if err := acmeSrv.Shutdown(shutdownCtx); err != nil {
			log.Warn("ACME HTTP server shutdown error", "error", err)
		}
	}

	srv.RegisterOnShutdown(api.CancelInFlightTransfers(srv))
	srv.RegisterOnShutdown(admin.EndArchives(srv))
	srv.RegisterOnShutdown(admin.EndApplies(srv))
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return nil
}
