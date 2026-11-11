// OwnCord chat server — self-hosted, Windows-native.
// Build: go build -o chatserver.exe -ldflags "-s -w -X main.version=1.0.0" .
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/internal/app"
	"github.com/J3vb/OwnCord/Server/logctx"
)

// version is set via -ldflags "-X main.version=1.0.0"; it stays in package main because the
// Makefile, release.yml and the Dockerfile name that symbol. app.Deps carries it onward.
var version = "dev"

// usageText is what `--help` prints: the subcommands main dispatches before starting the server.
const usageText = `OwnCord chat server

Usage:
  chatserver                 Start the server (reads config.yaml in the
                             working directory, creating it with defaults if
                             absent).
  chatserver --version       Print the build version and exit.
  chatserver --help          Print this help and exit.
  chatserver healthcheck     Probe the running server's /health and exit 0/1.
  chatserver token <cmd>     Mint, list or revoke API tokens (run
                             "chatserver token" for its own usage).
  chatserver restore <file>  Put a database backup back on a server that will
                             not boot (run "chatserver restore" for its own
                             usage; --force to replace the live database).
  chatserver config reset-overrides [--all] [key ...]
                             Drop settings saved from the admin panel so
                             config.yaml applies again (server stopped; run
                             "chatserver config" for its own usage).
`

// infoOutput returns the text args[0] asks for and true if it is an informational flag. Kept out
// of main so dispatch is testable without a subprocess.
func infoOutput(args []string) (string, bool) {
	if len(args) == 0 {
		return "", false
	}
	switch args[0] {
	case "--version":
		return version + "\n", true
	case "--help":
		return usageText, true
	}
	return "", false
}

func main() {
	// `--version`/`--help` exit before any setup, else config.Load would write a config.yaml into the cwd.
	if out, ok := infoOutput(os.Args[1:]); ok {
		fmt.Print(out)
		return
	}

	// `server healthcheck` probes /health and exits 0/1; the distroless image has no shell or curl.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(app.RunHealthcheckCLI())
	}
	// `server token ...` is a direct-to-DB CLI, handled before server/logging setup to stay quiet.
	if len(os.Args) > 1 && os.Args[1] == "token" {
		os.Exit(runTokenCLI(os.Args[2:]))
	}
	// `server restore <file>` is the offline counterpart of the admin restore endpoint; it takes the
	// database's process lock so a running server stops it. Handled before logging setup.
	if len(os.Args) > 1 && os.Args[1] == "restore" {
		os.Exit(runRestoreCLI(config.DefaultPath, os.Args[2:]))
	}
	// `server config reset-overrides` drops panel-saved settings while the server is stopped. Handled
	// before logging setup, and takes the same process lock.
	if len(os.Args) > 1 && os.Args[1] == "config" {
		os.Exit(runConfigCLI(config.DefaultPath, os.Args[2:]))
	}

	// Ring buffer for the admin log viewer, teed with stdout.
	logBuf := admin.NewRingBuffer(10000)
	// levelVar gates both handlers. It starts at INFO so early logs are captured, then app.LoadConfig
	// adjusts it; the ring shares it so gated Debug calls are no-ops instead of formatting an entry.
	levelVar := new(slog.LevelVar)
	stdoutHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: levelVar})
	multiHandler := admin.NewMultiHandler(stdoutHandler, logBuf, levelVar)
	// logctx adds req_id and, under -tags otel, trace_id to records logged with a context.
	log := slog.New(logctx.New(multiHandler))
	slog.SetDefault(log)

	// The restart coordinator carries a self-restart request across teardown (internal/app/restart.go);
	// the handoff below is this process's last act. The backstop fires only if the drain wedges past
	// RestartBackstopDelay: it hands off without waiting and force-exits, releasing what teardown holds.
	var rc *app.RestartCoordinator
	rc = app.NewRestartCoordinator(app.RestartBackstopDelay, func() {
		slog.Error("restart backstop fired — teardown exceeded its budget, exiting for handoff")
		code, _ := rc.PerformBackstopHandoff(slog.Default())
		os.Exit(code)
	})

	err := runServer(log, logBuf, levelVar, rc)
	rc.Disarm()

	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "\n  [ERROR] %v\n\n", err)
		log.Error("server exited with error", "error", err)
	}

	// Hand off even if the lifecycle errored: a restart is requested only after a committed binary swap
	// or a restore that closed the database, so not restarting is worse. A waiter exits with the
	// replacement's code.
	if code, waited := rc.PerformHandoff(log); waited {
		os.Exit(code)
	}

	if err != nil {
		os.Exit(1)
	}
}

// runServer is the whole server lifecycle: load config, build the App, run until every stage is
// closed. Split from main() so the restart handoff runs on every return path.
func runServer(log *slog.Logger, logBuf *admin.RingBuffer, levelVar *slog.LevelVar, rc *app.RestartCoordinator) error {
	cfg, baseLevel, err := app.LoadConfig(log, levelVar, rc)
	if err != nil {
		return err
	}
	a, err := app.New(cfg, app.Deps{
		Version: version, Log: log, LogBuf: logBuf, Restart: rc,
		LogLevelVar: levelVar, LogBaseLevel: baseLevel,
	})
	if err != nil {
		return err
	}
	return a.Run(context.Background())
}
