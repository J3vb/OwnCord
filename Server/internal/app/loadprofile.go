//go:build loadprofile

package app

// Opt-in pprof listener for the load-baseline workflow (`-f pprof=true`),
// compiled only with `-tags loadprofile` so a release binary carries none of
// it. OWNCORD_LOADPROFILE_ADDR names the loopback address to serve
// /debug/pprof/ on; unset leaves the build indistinguishable from a plain
// one. Block and mutex sampling are switched on because the profile this
// exists for (OC-0445) is contention on the single SQLite writer, which a
// CPU profile alone cannot see.

import (
	"log/slog"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime"
	"time"
)

func init() {
	addr := os.Getenv("OWNCORD_LOADPROFILE_ADDR")
	if addr == "" {
		return
	}
	runtime.SetBlockProfileRate(10_000) // one sample per 10µs blocked
	runtime.SetMutexProfileFraction(5)
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		slog.Warn("loadprofile: serving pprof — never enable this on a reachable address", "addr", addr)
		if err := srv.ListenAndServe(); err != nil {
			slog.Error("loadprofile: pprof listener stopped", "err", err)
		}
	}()
}
