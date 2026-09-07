package ws

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

type liveKitTestListeners struct {
	TCP string
	UDP string
}

// Re-execute the test binary as a small LiveKit stand-in. Dispatch before
// testing parses --config; a real process is needed to prove that Stop reaps
// the listener owner on Windows as well as Unix.
func init() {
	mode := os.Getenv("OWNCORD_LIVEKIT_TEST_PROCESS")
	if mode == "" || len(os.Args) != 3 || os.Args[1] != "--config" {
		return
	}
	runLiveKitTestProcess(filepath.Dir(os.Args[2]), mode)
	os.Exit(0)
}

func runLiveKitTestProcess(dir, mode string) {
	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		os.Exit(2)
	}
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		os.Exit(3)
	}
	terminated := make(chan os.Signal, 1)
	signal.Notify(terminated, syscall.SIGTERM)
	data, err := json.Marshal(liveKitTestListeners{TCP: tcp.Addr().String(), UDP: udp.LocalAddr().String()})
	if err != nil || os.WriteFile(filepath.Join(dir, "listeners.json.tmp"), data, 0o600) != nil {
		os.Exit(4)
	}
	if err := os.Rename(filepath.Join(dir, "listeners.json.tmp"), filepath.Join(dir, "listeners.json")); err != nil {
		os.Exit(4)
	}
	<-terminated
	if err := os.WriteFile(filepath.Join(dir, "term-received"), nil, 0o600); err != nil {
		os.Exit(5)
	}
	for {
		if mode != "ignore" {
			if _, err := os.Stat(filepath.Join(dir, "shutdown-release")); err == nil {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = tcp.Close()
	_ = udp.Close()
}

func startLiveKitTestProcess(t *testing.T, mode string) (*LiveKitProcess, liveKitTestListeners) {
	t.Helper()
	t.Setenv("OWNCORD_LIVEKIT_TEST_PROCESS", mode)
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	p := NewLiveKitProcess(&config.VoiceConfig{
		LiveKitAPIKey:     "test-key",
		LiveKitAPISecret:  "test-secret",
		LiveKitBinaryPath: bin,
	}, &config.TLSConfig{}, dir)
	if err := p.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Stop)
	waitForLiveKitTestFile(t, filepath.Join(dir, "listeners.json"))
	data, err := os.ReadFile(filepath.Join(dir, "listeners.json"))
	if err != nil {
		t.Fatal(err)
	}
	var listeners liveKitTestListeners
	if err := json.Unmarshal(data, &listeners); err != nil {
		t.Fatal(err)
	}
	return p, listeners
}

func waitForLiveKitTestFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("companion did not create %s", path)
		case <-tick.C:
		}
	}
}

func assertLiveKitPortsReleased(t *testing.T, listeners liveKitTestListeners) {
	t.Helper()
	tcp, err := net.Listen("tcp4", listeners.TCP)
	if err != nil {
		t.Fatalf("companion still owns TCP listener after Stop: %v", err)
	}
	defer tcp.Close()
	udp, err := net.ListenPacket("udp4", listeners.UDP)
	if err != nil {
		t.Fatalf("companion still owns UDP listener after Stop: %v", err)
	}
	_ = udp.Close()
}

func TestLiveKitProcess_ConcurrentStopWaitsForExitAndReleasesPorts(t *testing.T) {
	p, listeners := startLiveKitTestProcess(t, "graceful")
	p.mu.Lock()
	cmd := p.cmd
	p.mu.Unlock()

	stopped := make(chan struct{})
	go func() {
		var wg sync.WaitGroup
		for range 4 {
			wg.Go(p.Stop)
		}
		wg.Wait()
		close(stopped)
	}()
	if runtime.GOOS != "windows" {
		waitForLiveKitTestFile(t, filepath.Join(p.dataDir, "term-received"))
		select {
		case <-stopped:
			t.Fatal("Stop returned while the companion was still shutting down")
		default:
		}
		if err := os.WriteFile(filepath.Join(p.dataDir, "shutdown-release"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-stopped:
	case <-time.After(15 * time.Second):
		t.Fatal("Stop did not reap companion")
	}
	if p.IsRunning() || cmd.ProcessState == nil {
		t.Fatal("Stop returned without joining cmd.Wait")
	}
	assertLiveKitPortsReleased(t, listeners)
}

func TestLiveKitProcess_StopKillsCompanionThatIgnoresShutdown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows always uses immediate process termination")
	}
	p, listeners := startLiveKitTestProcess(t, "ignore")
	stopped := make(chan struct{})
	go func() {
		p.Stop()
		close(stopped)
	}()
	waitForLiveKitTestFile(t, filepath.Join(p.dataDir, "term-received"))
	select {
	case <-stopped:
	case <-time.After(15 * time.Second):
		t.Fatal("shutdown grace period did not escalate to a reaped kill")
	}
	assertLiveKitPortsReleased(t, listeners)
}

func TestLiveKitProcess_StopDuringDownloadAndRejectDuplicateStart(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("companion auto-download is supported on Linux and Windows")
	}
	requested := make(chan struct{})
	cancelled := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(requested)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer srv.Close()
	oldBase := livekitDownloadBase
	livekitDownloadBase = srv.URL
	defer func() { livekitDownloadBase = oldBase }()
	p := NewLiveKitProcess(&config.VoiceConfig{
		AutoDownloadLiveKit: true,
		LiveKitAPIKey:       "test-key",
		LiveKitAPISecret:    "test-secret",
	}, &config.TLSConfig{}, t.TempDir())
	if err := p.Start(); err != nil {
		t.Fatal(err)
	}
	defer p.Stop()
	select {
	case <-requested:
	case <-time.After(15 * time.Second):
		t.Fatal("download did not start")
	}
	if err := p.Start(); err == nil {
		t.Error("duplicate Start was allowed while the companion was downloading")
	}
	p.Stop()
	select {
	case <-cancelled:
	case <-time.After(15 * time.Second):
		t.Fatal("Stop did not cancel the in-flight download")
	}
	select {
	case <-p.loopDone:
	default:
		t.Error("Stop returned while the startup loop could still launch a companion")
	}
	if p.IsRunning() {
		t.Error("companion started during shutdown")
	}
}
