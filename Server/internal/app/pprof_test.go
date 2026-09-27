package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// A disabled pprof block starts no listener and registers no close step.
func TestStartPprof_DisabledIsNoop(t *testing.T) {
	a := &App{cfg: &config.Config{}, log: discardLogger()}
	if err := a.startPprof(); err != nil {
		t.Fatalf("startPprof (disabled): %v", err)
	}
	if a.pprofSrv != nil || len(a.closers) != 0 {
		t.Fatalf("disabled pprof started a listener or registered a close step")
	}
}

// An enabled pprof block binds only a loopback address, serves the profiler on
// its own socket and shuts down with the app.
func TestStartPprof_ServesOnLoopback(t *testing.T) {
	host, _, err := net.SplitHostPort(pprofAddr)
	if ip := net.ParseIP(host); err != nil || ip == nil || !ip.IsLoopback() {
		t.Fatalf("pprofAddr = %q, want an explicit loopback IP", pprofAddr)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	prev := pprofAddr
	pprofAddr = addr
	t.Cleanup(func() { pprofAddr = prev })
	a := &App{cfg: &config.Config{Server: config.ServerConfig{PprofEnabled: true}}, log: discardLogger()}
	if err := a.startPprof(); err != nil {
		t.Fatalf("startPprof: %v", err)
	}
	defer stopPprof(t, a)

	resp, err := http.Get("http://" + addr + "/debug/pprof/")
	if err != nil {
		t.Fatalf("GET /debug/pprof/: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
}

func stopPprof(t *testing.T, a *App) {
	t.Helper()
	for _, c := range a.closers {
		if c.stage == "pprof" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = c.stop(ctx)
			return
		}
	}
	t.Fatal("no pprof close step registered")
}
