package main

import (
	"io"
	"log/slog"
	"testing"

	"go.uber.org/goleak"

	"github.com/owncord/server/admin"
)

// TestRun_ServeErrorReturn_StopsHubDispatchGoroutine pins OC-0027:
// hub.GracefulStop() (the only caller of LiveKitProcess.Stop(), and what
// closes the hub's dispatch goroutine) is a plain statement reached only on
// the graceful-shutdown path. The serve-error branch — `case err :=
// <-serveErr: ... return fmt.Errorf(...)` — returns from run() before ever
// reaching it, so the hub's `go hub.Run()` dispatch goroutine (started by
// api.NewRouter) is left running, and in production the companion
// livekit-server process it owns is left running with it.
//
// An out-of-range port fails the first listen attempt with an error that
// isAddrInUse does not recognize, so run() takes the servErr branch
// immediately instead of retrying for ~10s.
func TestRun_ServeErrorReturn_StopsHubDispatchGoroutine(t *testing.T) {
	t.Chdir(t.TempDir())

	t.Setenv("OWNCORD_SERVER_PORT", "99999")                 // out of range: immediate, non-retryable listen error
	t.Setenv("OWNCORD_TLS_MODE", "off")                      // skip self-signed cert generation
	t.Setenv("OWNCORD_VOICE_AUTO_DOWNLOAD_LIVEKIT", "false") // the generated default config.yaml turns this on; keep the test offline

	logBuf := admin.NewRingBuffer(64)
	levelVar := new(slog.LevelVar)
	log := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: levelVar}))

	leakOpt := goleak.IgnoreCurrent()

	if err := run(log, logBuf, levelVar); err == nil {
		t.Fatal("expected run() to return an error for an out-of-range port")
	}

	// hub.Run's dispatch goroutine only exits once hub.stop is closed, which
	// only happens inside hub.GracefulStop(). If run() returned without
	// calling it, this goroutine is still alive here.
	if err := goleak.Find(leakOpt); err != nil {
		t.Fatalf("hub dispatch goroutine (and, in production, its LiveKit process) leaked after run() returned early: %v", err)
	}
}
