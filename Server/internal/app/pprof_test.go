package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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
	// The samplers must be left exactly as they were: enabling the listener is
	// what turns them on, so a disabled profiler adds no runtime overhead.
	// (SetMutexProfileFraction(-1) reads the current fraction without changing
	// it; runtime exposes no block-rate getter, so the mutex fraction stands in
	// for both.)
	before := runtime.SetMutexProfileFraction(-1)
	if err := a.startPprof(); err != nil {
		t.Fatalf("startPprof (disabled): %v", err)
	}
	if a.pprofSrv != nil || len(a.closers) != 0 {
		t.Fatalf("disabled pprof started a listener or registered a close step")
	}
	if after := runtime.SetMutexProfileFraction(-1); after != before {
		t.Errorf("mutex profile fraction changed from %d to %d with pprof disabled", before, after)
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

//go:noinline
func contendedMutexWorker(mu *sync.Mutex, start, done chan struct{}) {
	<-start
	mu.Lock()
	close(done)
	mu.Unlock()
}

// With pprof enabled the block sampler must be on, so a contended mutex shows
// up in /debug/pprof/block. Without it the profile is empty and a load run
// cannot see SQLite-writer contention (P5-O09).
func TestStartPprof_BlockProfileServesContention(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	prev := pprofAddr
	pprofAddr = addr
	t.Cleanup(func() {
		pprofAddr = prev
		runtime.SetBlockProfileRate(0)
		runtime.SetMutexProfileFraction(0)
	})
	a := &App{cfg: loadPprofConfig(t), log: discardLogger()}
	if err := a.startPprof(); err != nil {
		t.Fatalf("startPprof: %v", err)
	}
	defer stopPprof(t, a)

	var mu sync.Mutex
	mu.Lock()
	start := make(chan struct{})
	done := make(chan struct{})
	go contendedMutexWorker(&mu, start, done)
	close(start)
	time.Sleep(100 * time.Millisecond) // hold the lock well past the sampling threshold
	mu.Unlock()
	<-done

	resp, err := http.Get("http://" + addr + "/debug/pprof/block?debug=1")
	if err != nil {
		t.Fatalf("GET /debug/pprof/block: %v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read block profile: %v", err)
	}
	if !strings.Contains(string(body), "contendedMutexWorker") {
		t.Fatalf("block profile after contention does not name the blocking call; body:\n%s", body)
	}
}

// loadPprofConfig returns the default configuration with pprof switched on,
// built through config.Load so it carries the same block/mutex defaults a boot
// would (a bare struct literal would silently miss them).
func loadPprofConfig(t *testing.T) *config.Config {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("server:\n  pprof_enabled: true\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	return cfg
}

func stopPprof(t *testing.T, a *App) {
	t.Helper()
	for _, c := range a.closers {
		if c.stage == "pprof" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = c.stop(ctx)
			cancel()
			return
		}
	}
	t.Fatal("no pprof close step registered")
}
