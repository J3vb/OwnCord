package admin

import (
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// ─── SetupOptions ────────────────────────────────────────────────────────────

// SetupOptions wires the first-run setup wizard to the running server. The
// zero value disables everything beyond legacy owner-account creation, which
// keeps every existing NewAdminAPI/NewHandler call site behaving as before.
type SetupOptions struct {
	// ConfigPath is the config.yaml path the wizard patches. Empty disables
	// config writing entirely.
	ConfigPath string
	// RunningCfg is the configuration the server booted with. It provides the
	// wizard's prefill defaults, the values compared against to decide whether
	// a restart is needed, and the generated LiveKit credentials to persist.
	// Nil disables prefill and restarting.
	RunningCfg *config.Config
	// Restart replaces the process-restart hook (tests). Nil = requestRestart.
	Restart func(reason string)
	// SetupToken, when non-empty, must accompany POST /api/setup. The server
	// generates one per start and prints it to its own console only, so
	// creating the owner account takes access to the host's start-up output,
	// not just an address inside admin_allowed_cidrs. Empty = not required
	// (the direct-construction test path).
	SetupToken string
	// LogLevel, when non-nil, backs GET/PATCH /logs/level (SRE-07): the
	// running log level and a timed debug boost that reverts on its own. Nil
	// leaves the endpoints answering 503, which is the direct-construction
	// test path and the one place no *slog.LevelVar exists to retune.
	LogLevel *LogLevelController
	// Background is the app's request-path job group (ARCH-034). The update
	// apply tail runs on it, so a shutdown aborts the countdown and joins the
	// tail before the database closes. Nil runs the tail on an unowned group
	// (tests, direct construction).
	Background *syncutil.Group
	// Shutdown closes when the process begins to shut down, at the start of
	// App.Close. The update apply tail watches it so a SIGTERM during the
	// restart countdown aborts the binary swap. Nil never fires.
	Shutdown <-chan struct{}
}
