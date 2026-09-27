package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/pprof"
	"time"
)

// startPprof starts the opt-in pprof listener (SRE-M1). It is off by default,
// on its own socket bound to loopback, and deliberately never mounted on the
// main router: a profiling endpoint exposes heap contents and can burn CPU, so
// the operator must ask for it and must reach the host to use it. A
// non-loopback address is refused at startup rather than silently exposing the
// profiler. Nothing runs when the key is unset.
func (a *App) startPprof() error {
	if !a.cfg.Server.PprofEnabled {
		return nil
	}
	addr := a.cfg.Server.PprofAddr
	if !pprofLoopbackAddr(addr) {
		return errors.New("server.pprof_addr " + addr + " is not a loopback host:port; pprof exposes heap contents and CPU burn, so it only binds loopback (use an SSH port-forward)")
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{
		Handler:      pprofMux(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second, // a CPU profile can take seconds to stream
	}
	a.pprofSrv = srv
	a.onClose("pprof", func(ctx context.Context) error {
		// Shutdown stops accepting and drains an active profile request; one
		// held past the budget is cut by the deadline.
		_ = srv.Shutdown(ctx)
		return nil
	})
	go func() {
		a.log.Info("pprof listener starting", "addr", addr)
		if serveErr := srv.Serve(ln); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			a.log.Error("pprof listener error", "error", serveErr)
		}
	}()
	return nil
}

// pprofLoopbackAddr reports whether addr is a host:port whose host is an
// explicit loopback address or "localhost". An empty host (":6060") binds
// every interface and is refused.
func pprofLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil || host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// pprofMux mounts exactly Go's net/http/pprof handlers. It is built here rather
// than via a blank import of net/http/pprof, which would register them on the
// DefaultServeMux and risk surfacing them on the main router.
func pprofMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}
