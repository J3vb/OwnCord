package app

import (
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"testing"
	"time"

	"go.uber.org/goleak"

	"github.com/J3vb/OwnCord/Server/admin"
)

func TestRestartCoordinator_RequestIdempotent(t *testing.T) {
	rc := NewRestartCoordinator(time.Hour, nil)
	defer rc.Disarm()

	if reason, ok := rc.Requested(); ok || reason != "" {
		t.Fatalf("fresh coordinator Requested() = %q, %v; want none", reason, ok)
	}

	rc.Request("first")
	rc.Request("second")

	reason, ok := rc.Requested()
	if !ok || reason != "first" {
		t.Errorf("Requested() = %q, %v; want first reason to win", reason, ok)
	}
	select {
	case <-rc.Context().Done():
	default:
		t.Error("coordinator context not cancelled after Request")
	}
}

// Cancelling the coordinator's context must drive a signal.NotifyContext
// built on top of it — that is the whole mechanism by which a restart
// request drains Run exactly like a SIGTERM, on every platform.
func TestRestartCoordinator_CancelDrivesNotifyContext(t *testing.T) {
	rc := NewRestartCoordinator(time.Hour, nil)
	defer rc.Disarm()

	ctx, stop := signal.NotifyContext(rc.Context(), os.Interrupt)
	defer stop()

	rc.Request("test")

	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("NotifyContext not done after coordinator Request — restart requests would never drain the server")
	}
}

func TestRestartCoordinator_Backstop(t *testing.T) {
	t.Run("fires after the delay", func(t *testing.T) {
		fired := make(chan struct{})
		rc := NewRestartCoordinator(10*time.Millisecond, func() { close(fired) })
		rc.Request("test")
		select {
		case <-fired:
		case <-time.After(2 * time.Second):
			t.Fatal("backstop did not fire")
		}
	})

	t.Run("Disarm stops it", func(t *testing.T) {
		fired := make(chan struct{})
		rc := NewRestartCoordinator(50*time.Millisecond, func() { close(fired) })
		rc.Request("test")
		rc.Disarm()
		select {
		case <-fired:
			t.Fatal("backstop fired after Disarm")
		case <-time.After(200 * time.Millisecond):
		}
	})

	t.Run("not armed without a request", func(t *testing.T) {
		fired := make(chan struct{})
		_ = NewRestartCoordinator(10*time.Millisecond, func() { close(fired) })
		select {
		case <-fired:
			t.Fatal("backstop fired without a restart request")
		case <-time.After(100 * time.Millisecond):
		}
	})
}

func TestResolveRestartMode(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// Pin every detector input: CI runners themselves can execute under
	// systemd and carry a real INVOCATION_ID into the test process.
	// present-but-empty counts as unset for all three.
	pinBare := func(t *testing.T) {
		t.Setenv("INVOCATION_ID", "")
		t.Setenv("NSSM_SERVICE_NAME", "")
		t.Setenv("OWNCORD_CONTAINER", "0")
	}

	t.Run("explicit values win over detection", func(t *testing.T) {
		t.Setenv("INVOCATION_ID", "detected-supervisor")
		if got := resolveRestartMode("spawn", log); got != restartModeSpawn {
			t.Errorf("resolveRestartMode(spawn) = %q under systemd, want spawn", got)
		}
		pinBare(t)
		if got := resolveRestartMode("supervised", log); got != restartModeSupervised {
			t.Errorf("resolveRestartMode(supervised) = %q on bare metal, want supervised", got)
		}
	})

	t.Run("auto on bare metal spawns", func(t *testing.T) {
		pinBare(t)
		for _, v := range []string{"auto", "", "bogus-mode"} {
			if got := resolveRestartMode(v, log); got != restartModeSpawn {
				t.Errorf("resolveRestartMode(%q) = %q, want spawn", v, got)
			}
		}
	})

	t.Run("auto under systemd is supervised", func(t *testing.T) {
		pinBare(t)
		t.Setenv("INVOCATION_ID", "4a1f3b0e9c8d4e2f")
		if got := resolveRestartMode("auto", log); got != restartModeSupervised {
			t.Errorf("resolveRestartMode(auto) = %q, want supervised", got)
		}
	})

	t.Run("auto in a container is supervised", func(t *testing.T) {
		pinBare(t)
		t.Setenv("OWNCORD_CONTAINER", "1")
		if got := resolveRestartMode("auto", log); got != restartModeSupervised {
			t.Errorf("resolveRestartMode(auto) = %q, want supervised (restore/wizard restarts in Docker rely on the restart policy)", got)
		}
	})
}

func TestPerformRestartHandoff(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	type call struct {
		exe  string
		args []string
	}
	var calls []call
	prev := spawnReplacement
	spawnReplacement = func(exePath string, args []string) error {
		calls = append(calls, call{exePath, args})
		return nil
	}
	defer func() { spawnReplacement = prev }()

	PerformRestartHandoff("update", restartModeSupervised, log)
	if len(calls) != 0 {
		t.Fatalf("supervised handoff spawned a process: %+v — the supervisor owns the relaunch", calls)
	}

	PerformRestartHandoff("update", restartModeSpawn, log)
	if len(calls) != 1 {
		t.Fatalf("spawn handoff made %d spawn calls, want 1", len(calls))
	}
	if calls[0].exe == "" {
		t.Error("spawn handoff passed an empty executable path")
	}

	// A failing spawn must be survivable (logged, no panic) — there is no
	// hub left to notify at this point.
	spawnReplacement = func(string, []string) error { return fmt.Errorf("injected spawn failure") }
	PerformRestartHandoff("update", restartModeSpawn, log)
}

// TestRun_RestartRequest_DrainsCleanly drives Run end to end: boot on a
// real port, request a restart through the coordinator (exactly what an
// admin update/restore does via admin.SetRestartHandoff), and assert Run
// drains and returns nil with no leaked goroutines — the property main()'s
// post-run handoff depends on (DB closed and lock released, port free,
// LiveKit stopped) before it starts the successor.
func TestRun_RestartRequest_DrainsCleanly(t *testing.T) {
	t.Chdir(t.TempDir())

	// Grab a free port, release it, and hand it to Run. The tiny window
	// where something else could take it is absorbed by Run's bind retry.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()

	t.Setenv("OWNCORD_SERVER_PORT", fmt.Sprint(port))
	t.Setenv("OWNCORD_TLS_MODE", "off")
	t.Setenv("OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT", "false") // keep the test offline

	logBuf := admin.NewRingBuffer(64)
	levelVar := new(slog.LevelVar)
	log := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: levelVar}))

	leakOpt := goleak.IgnoreCurrent()

	rc := NewRestartCoordinator(time.Hour, nil)
	runErr := make(chan error, 1)
	go func() { runErr <- runApp(log, logBuf, levelVar, rc) }()

	// Wait for the server to actually serve before requesting the restart.
	healthURL := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	up := false
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); {
		resp, healthErr := http.Get(healthURL) //nolint:gosec // G107: loopback URL built from the test's own port
		if healthErr == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			up = true
			break
		}
		select {
		case err := <-runErr:
			t.Fatalf("Run exited before serving: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	if !up {
		t.Fatal("server never became reachable on /health")
	}

	rc.Request("test-restart")

	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("Run after restart request = %v, want nil (clean drain)", err)
		}
	case <-time.After(60 * time.Second):
		t.Fatal("Run did not return after the restart request")
	}
	rc.Disarm()

	if reason, ok := rc.Requested(); !ok || reason != "test-restart" {
		t.Errorf("Requested() = %q, %v; want the recorded restart", reason, ok)
	}

	// Everything must have drained: this is the guarantee that lets main()
	// start the successor with zero lock/port contention.
	if err := goleak.Find(leakOpt); err != nil {
		t.Errorf("goroutines leaked after a restart-request drain: %v", err)
	}

	// The port must actually be free again.
	relisten, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Errorf("port still held after drain: %v", err)
	} else {
		_ = relisten.Close()
	}
}
