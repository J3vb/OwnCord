package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/pprof"
	"runtime"
	"time"
)

// pprofAddr is the pprof listener's loopback address; a var so tests can bind a
// free port.
var pprofAddr = "127.0.0.1:6060"

// startPprof starts the opt-in pprof listener, off by default, on its own
// loopback socket and never on the main router: a profiling endpoint exposes
// heap contents and can burn CPU, so enabling it can never expose the profiler
// off-host.
func (a *App) startPprof() error {
	if !a.cfg.Server.PprofEnabled {
		return nil
	}
	runtime.SetBlockProfileRate(a.cfg.Server.PprofBlockProfileRate)
	runtime.SetMutexProfileFraction(a.cfg.Server.PprofMutexProfileFraction)
	addr := pprofAddr
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

// pprofMux mounts exactly Go's net/http/pprof handlers, not via a blank import,
// which would register them on the DefaultServeMux and risk surfacing them on
// the main router.
func pprofMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}
