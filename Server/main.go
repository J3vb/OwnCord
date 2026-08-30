// OwnCord chat server — self-hosted, Windows-native.
// Build: go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/logctx"
)

// version is overridden at build time via -ldflags "-X main.version=1.0.0".
// It stays in package main because that is the symbol the Makefile and
// release.yml name; app.Run takes it as a parameter.
var version = "dev"

func main() {
	// `server healthcheck` probes the running instance's /health and exits
	// 0/1. It exists for container healthchecks: the distroless image has no
	// shell or curl, so the binary is its own probe.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(app.RunHealthcheckCLI())
	}
	// `server token ...` is a direct-to-DB CLI (mint/list/revoke API tokens) —
	// handled before any server/logging setup so it stays quiet and standalone.
	if len(os.Args) > 1 && os.Args[1] == "token" {
		os.Exit(runTokenCLI(os.Args[2:]))
	}

	// Create ring buffer for admin log viewer, then build a multi-handler
	// that tees log records to both stdout and the ring buffer.
	logBuf := admin.NewRingBuffer(2000)
	// levelVar controls both handlers' thresholds. It starts at INFO (the
	// zero value) so early-startup logs are captured, then app.Run raises or
	// lowers it once config.yaml / OWNCORD_LOGGING_LEVEL is loaded. The ring
	// buffer shares it rather than hard-wiring DEBUG: with both sinks gated,
	// Enabled returns false for suppressed levels and every gated Debug call
	// across the server becomes a no-op instead of formatting a ring entry.
	levelVar := new(slog.LevelVar)
	stdoutHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: levelVar})
	multiHandler := admin.NewMultiHandler(stdoutHandler, logBuf, levelVar)
	// logctx enriches records logged with a request/trace context (the
	// ...Context slog variants) with req_id and, under -tags otel, trace_id.
	log := slog.New(logctx.New(multiHandler))
	slog.SetDefault(log)

	// The restart coordinator carries a self-restart request (update apply,
	// backup restore, setup wizard) across the lifecycle's teardown — see
	// internal/app/restart.go. main owns it and hands it in; the handoff
	// below is the last thing this process does. The backstop closure fires
	// only if a requested restart's drain wedges past RestartBackstopDelay:
	// it performs the handoff and force-exits, mirroring what the code below
	// does on the healthy path.
	var rc *app.RestartCoordinator
	rc = app.NewRestartCoordinator(app.RestartBackstopDelay, func() {
		slog.Error("restart backstop fired — teardown exceeded its budget, exiting for handoff")
		reason, _ := rc.Requested()
		app.PerformRestartHandoff(reason, rc.Mode(), slog.Default())
		os.Exit(0)
	})

	err := app.Run(version, log, logBuf, levelVar, rc)
	rc.Disarm()

	// Perform the handoff even when the lifecycle returned an error: a
	// restart is only ever requested after a committed binary swap or a
	// restore that closed the database, so not restarting is strictly worse
	// than restarting into whatever the error was.
	if reason, ok := rc.Requested(); ok {
		app.PerformRestartHandoff(reason, rc.Mode(), log)
	}

	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "\n  [ERROR] %v\n\n", err)
		log.Error("server exited with error", "error", err)
		os.Exit(1)
	}
}
