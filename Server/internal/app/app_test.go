package app

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"go.uber.org/goleak"

	"github.com/J3vb/OwnCord/Server/admin"
)

// runApp is what main()'s runServer does, condensed: load the configuration,
// build the App, run it until it stops and has closed every stage it started.
// The end-to-end tests drive the lifecycle through this rather than through a
// package-level entry point, because that is now exactly what the process
// does.
func runApp(log *slog.Logger, logBuf *admin.RingBuffer, levelVar *slog.LevelVar, rc *RestartCoordinator) error {
	cfg, err := LoadConfig(log, levelVar, rc)
	if err != nil {
		return err
	}
	a, err := New(cfg, Deps{Version: "test", Log: log, LogBuf: logBuf, Restart: rc})
	if err != nil {
		return err
	}
	return a.Run(context.Background())
}

// bootTestApp builds a real App the way main() does — LoadConfig against a
// generated default config.yaml in a temp directory, then New — with TLS and
// the LiveKit auto-download turned off so the test stays offline and never
// generates a certificate. failStage, when non-empty, makes that start stage
// fail instead of running (see App.start); every stage before it starts for
// real, which is the point: the assertions are about what teardown does with
// what was already up.
func bootTestApp(t *testing.T, port, failStage string) *App {
	t.Helper()
	t.Chdir(t.TempDir())
	t.Setenv("OWNCORD_SERVER_PORT", port)
	t.Setenv("OWNCORD_TLS_MODE", "off")
	t.Setenv("OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT", "false")

	levelVar := new(slog.LevelVar)
	log := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: levelVar}))
	rc := NewRestartCoordinator(time.Hour, nil)

	cfg, err := LoadConfig(log, levelVar, rc)
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	a, err := New(cfg, Deps{Version: "test", Log: log, LogBuf: admin.NewRingBuffer(64), Restart: rc})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	a.failStage = failStage
	return a
}

// TestAppRun_LateStageFailure_StopsTheHubAndClosesTheDatabase is the third
// property of the composite close, and the one OC-0027 is about: when a
// stage that starts AFTER the router fails, the hub is already running and
// its dispatch goroutine owns the companion livekit-server process.
// hub.GracefulStop is the only caller of LiveKitProcess.Stop, so a teardown
// that skips it orphans a real process. Before B3-3 this held only because
// `defer hub.GracefulStop()` sat above every early return in run(); now it
// is a closer, and this is what proves the closer actually runs.
func TestAppRun_LateStageFailure_StopsTheHubAndClosesTheDatabase(t *testing.T) {
	leakOpt := goleak.IgnoreCurrent()
	a := bootTestApp(t, "0", "maintenance")

	err := a.Run(context.Background())
	if err == nil {
		t.Fatal("Run() = nil, want the injected maintenance failure")
	}
	if !strings.Contains(err.Error(), "maintenance") {
		t.Errorf("Run() = %v, want an error naming the stage that failed (maintenance)", err)
	}

	if a.hub == nil {
		t.Fatal("the router stage runs before maintenance, so the hub must have been built")
	}
	if a.hub.DispatchAlive() {
		t.Error("hub dispatch is still alive after Run returned — GracefulStop was skipped, so a supervised LiveKit process would be orphaned")
	}
	if err := a.database.PingRead(context.Background()); err == nil {
		t.Error("the database handle is still open after Run returned")
	}
	if err := goleak.Find(leakOpt); err != nil {
		t.Fatalf("goroutine leaked after a failed start: %v", err)
	}
}
