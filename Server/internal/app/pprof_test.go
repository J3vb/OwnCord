package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// pprofLoopbackAddr must accept only explicit loopback hosts. ":6060" binds
// every interface and "0.0.0.0:6060" is public; both must be refused, or the
// opt-in profiler becomes an accidental public one.
func TestPprofLoopbackAddr(t *testing.T) {
	cases := []struct {
		addr string
		want bool
	}{
		{"127.0.0.1:6060", true},
		{"localhost:6060", true},
		{"[::1]:6060", true},
		{":6060", false},
		{"0.0.0.0:6060", false},
		{"192.168.1.5:6060", false},
		{"example.com:6060", false},
		{"not-an-address", false},
	}
	for _, tc := range cases {
		if got := pprofLoopbackAddr(tc.addr); got != tc.want {
			t.Errorf("pprofLoopbackAddr(%q) = %v, want %v", tc.addr, got, tc.want)
		}
	}
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

// A non-loopback address is refused before any bind happens.
func TestStartPprof_RefusesNonLoopback(t *testing.T) {
	a := &App{cfg: &config.Config{Server: config.ServerConfig{PprofEnabled: true, PprofAddr: "0.0.0.0:6060"}}, log: discardLogger()}
	if err := a.startPprof(); err == nil {
		t.Fatal("startPprof bound a non-loopback address, want a refusal")
	}
	if a.pprofSrv != nil {
		t.Fatal("a refused pprof start left a listener behind")
	}
}

// An enabled loopback pprof block serves the profiler on its own socket and
// shuts down with the app.
func TestStartPprof_ServesOnLoopback(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	a := &App{cfg: &config.Config{Server: config.ServerConfig{PprofEnabled: true, PprofAddr: addr}}, log: discardLogger()}
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
