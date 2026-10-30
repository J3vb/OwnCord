package admin

import (
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

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
	// LogLevel, when non-nil, backs GET/PATCH /logs/level: the
	// running log level and a timed debug boost that reverts on its own. Nil
	// leaves the endpoints answering 503, which is the direct-construction
	// test path and the one place no *slog.LevelVar exists to retune.
	LogLevel *LogLevelController
	// BackupDir is the directory the backup, restore and archive handlers use
	// (cfg.Backup.Dir). Empty keeps the default, data/backups, resolved to an
	// absolute path when the API is built.
	BackupDir string
	// DatabasePath is the SQLite file "Restore backup" stages a copy beside
	// (cfg.Database.Path). Empty keeps the historical data/chatserver.db. Without
	// the real path, a server with a non-default database.path would report a
	// restore staged while its live database is never replaced.
	DatabasePath string
	// Background is the app's request-path job group. The update
	// apply tail runs on it, so a shutdown aborts the countdown and joins the
	// tail before the database closes. Nil runs the tail on an unowned group
	// (tests, direct construction).
	Background *syncutil.Group
	// Shutdown closes when the process begins to shut down, at the start of
	// App.Close. The update apply tail watches it so a SIGTERM during the
	// restart countdown aborts the binary swap. Nil never fires.
	Shutdown <-chan struct{}
	// DiscordImport runs "Import from Discord". Nil answers its routes 503,
	// the direct-construction test path.
	DiscordImport DiscordImporter
	// ImportDir is where an uploaded export is held while it imports; the
	// system temp directory when empty.
	ImportDir string
	// ImportMaxBytes caps one export upload (upload.import_max_mb);
	// DefaultImportMaxBytes when zero.
	ImportMaxBytes int64
	// BeginTransfer gives the upload route the long-transfer deadline of the
	// file routes. Nil leaves only the size cap.
	BeginTransfer TransferBegin
	// System feeds the Dashboard health row. The zero value serves uptime-less
	// answers with every CPU, memory and disk figure null.
	System SystemSources
}
