package livekitproc

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// fakeCompanion writes a stand-in binary that exits at once with an error, or,
// once the file "ok" exists next to it, keeps running like a healthy LiveKit.
func fakeCompanion(t *testing.T) (dir, bin string) {
	t.Helper()
	dir = t.TempDir()
	bin = filepath.Join(dir, "fake-livekit.sh")
	content := "#!/bin/sh\nif [ -f \"$(dirname \"$0\")/ok\" ]; then sleep 30; fi\nexit 1\n"
	if runtime.GOOS == "windows" {
		bin = filepath.Join(dir, "fake-livekit.bat")
		content = "@if exist \"%~dp0ok\" ping -n 30 127.0.0.1 > nul\r\n@exit /b 1\r\n"
	}
	if err := os.WriteFile(bin, []byte(content), 0o700); err != nil {
		t.Fatalf("write fake binary: %v", err)
	}
	return dir, bin
}

func startRecoveryProcess(t *testing.T, tm restartTiming) (p *Process, dir string) {
	t.Helper()
	dir, bin := fakeCompanion(t)
	p = New(&config.VoiceConfig{
		LiveKitAPIKey:     "test-key",
		LiveKitAPISecret:  "test-secret",
		LiveKitBinaryPath: bin,
	}, &config.TLSConfig{}, dir)
	p.timing = tm
	if err := p.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Stop)
	return p, dir
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func quickTiming(retries int, slow time.Duration) restartTiming {
	return restartTiming{
		baseDelay:   time.Millisecond,
		maxDelay:    2 * time.Millisecond,
		maxRetries:  retries,
		stableAfter: 30 * time.Second,
		slowRetry:   slow,
	}
}

func gaveUpWaiting(p *Process) bool {
	s := p.Status()
	return s.GaveUp && !s.NextRetryAt.IsZero()
}

// After the quick restarts run out the supervisor keeps trying on the slow
// timer, one attempt per tick, instead of stopping for good.
func TestRecovery_SlowTierKeepsTrying(t *testing.T) {
	p, _ := startRecoveryProcess(t, quickTiming(3, 20*time.Millisecond))

	waitFor(t, "two slow-tier attempts", func() bool { return p.Status().Restarts >= 5 })
	if !p.Status().GaveUp {
		t.Error("a failing slow-tier attempt cleared gave-up")
	}
	select {
	case <-p.loopDone:
		t.Fatal("runLoop exited after giving up")
	default:
	}
}

// A slow-tier attempt that comes up clears gave-up while it runs.
func TestRecovery_SlowTierAttemptThatStartsClearsGaveUp(t *testing.T) {
	p, dir := startRecoveryProcess(t, quickTiming(2, 50*time.Millisecond))
	waitFor(t, "gave up", func() bool { return gaveUpWaiting(p) })

	if err := os.WriteFile(filepath.Join(dir, "ok"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "a running companion", func() bool { s := p.Status(); return s.Running && !s.GaveUp })
	if s := p.Status(); !s.NextRetryAt.IsZero() {
		t.Errorf("next retry %v still set while running", s.NextRetryAt)
	}
	if p.Restart() {
		t.Error("Restart accepted while the companion runs")
	}
}

// Restart wakes the slow tier at once and gives back the full set of quick
// retries; with nothing to restart it reports false and starts nothing.
func TestRecovery_RestartRunsTheQuickTierAgain(t *testing.T) {
	p, _ := startRecoveryProcess(t, quickTiming(3, time.Hour))
	waitFor(t, "gave up", func() bool { return gaveUpWaiting(p) })
	before := p.Status().Restarts

	if !p.Restart() {
		t.Fatal("Restart refused while gave up")
	}
	waitFor(t, "a fresh quick tier", func() bool { return p.Status().Restarts >= before+3 && gaveUpWaiting(p) })
	if got := p.Status().Restarts; got != before+3 {
		t.Errorf("restarts = %d after one press, want %d (one quick tier)", got, before+3)
	}
}

// Two presses at once wake the loop once: one quick tier, not two.
func TestRecovery_ConcurrentRestartsWakeOnce(t *testing.T) {
	p, _ := startRecoveryProcess(t, quickTiming(2, time.Hour))
	waitFor(t, "gave up", func() bool { return gaveUpWaiting(p) })
	before := p.Status().Restarts

	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() { p.Restart() })
	}
	wg.Wait()
	waitFor(t, "back in the slow tier", func() bool { return p.Status().Restarts >= before+2 && gaveUpWaiting(p) })
	time.Sleep(50 * time.Millisecond)
	if got := p.Status().Restarts; got != before+2 {
		t.Errorf("restarts = %d after two concurrent presses, want %d", got, before+2)
	}
}

// Restart racing Stop: Stop still returns, nothing starts after it, and a
// press after Stop is refused.
func TestRecovery_RestartRacingStop(t *testing.T) {
	for range 20 {
		p, _ := startRecoveryProcess(t, quickTiming(1, time.Hour))
		waitFor(t, "gave up", func() bool { return gaveUpWaiting(p) })

		var wg sync.WaitGroup
		wg.Go(func() { p.Restart() })
		wg.Go(p.Stop)
		wg.Wait()

		after := p.Status()
		if after.Running {
			t.Fatal("a companion runs after Stop returned")
		}
		if p.Restart() {
			t.Fatal("Restart accepted after Stop")
		}
		time.Sleep(5 * time.Millisecond)
		if got := p.Status().Restarts; got != after.Restarts {
			t.Fatalf("restarts moved from %d to %d after Stop", after.Restarts, got)
		}
	}
}

// A nil manager (external LiveKit) has nothing to restart.
func TestRecovery_RestartNilManager(t *testing.T) {
	var p *Process
	if p.Restart() {
		t.Error("nil manager accepted a restart")
	}
}
