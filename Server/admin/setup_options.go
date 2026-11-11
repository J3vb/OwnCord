package admin

import (
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// SetupOptions wires the first-run wizard to the running server; the zero value disables everything beyond
// legacy owner-account creation.
type SetupOptions struct {
	// ConfigPath is the config.yaml the wizard patches; empty disables config writing.
	ConfigPath string
	// RunningCfg is the booted configuration: wizard prefill defaults, the baseline for deciding a restart, and
	// the generated LiveKit credentials to persist. Nil disables prefill and restarting.
	RunningCfg *config.Config
	// Restart replaces the process-restart hook (tests). Nil = requestRestart.
	Restart func(reason string)
	// SetupToken, when non-empty, must accompany POST /api/setup. The server prints a per-start token to its own
	// console only, so creating the owner takes access to the host's start-up output, not just an address inside
	// admin_allowed_cidrs. Empty = not required (test path).
	SetupToken string
	// LogLevel backs GET/PATCH /logs/level (running level plus a timed debug boost). Nil answers 503: the test
	// path, where no *slog.LevelVar exists.
	LogLevel *LogLevelController
	// BackupDir is where backup, restore and archive handlers work (cfg.Backup.Dir); empty means data/backups,
	// made absolute at build.
	BackupDir string
	// DatabasePath is the SQLite file a restore stages beside (cfg.Database.Path). Without the real path, a
	// non-default database.path would report a restore staged while the live database is never replaced.
	DatabasePath string
	// Background is the app's request-path job group; the update apply tail runs on it so shutdown aborts the
	// countdown and joins it before the database closes. Nil runs it unowned (tests).
	Background *syncutil.Group
	// Shutdown closes at the start of App.Close so a SIGTERM during the restart countdown aborts the binary
	// swap. Nil never fires.
	Shutdown <-chan struct{}
	// DiscordImport runs the import; nil answers its routes 503 (test path).
	DiscordImport DiscordImporter
	// ImportDir holds an uploaded export while it imports; the system temp dir when empty.
	ImportDir string
	// ImportMaxBytes caps one export upload (upload.import_max_mb); DefaultImportMaxBytes when zero.
	ImportMaxBytes int64
	// BeginTransfer gives the upload route the long-transfer deadline of the file routes; nil leaves only the
	// size cap.
	BeginTransfer TransferBegin
	// LogHistoryDir holds saved log files (cfg.LogHistoryDir()); empty turns history off (GET /logs/history
	// answers enabled:false).
	LogHistoryDir string
	// System feeds the Dashboard health row; the zero value serves uptime-less answers with CPU, memory and disk
	// null.
	System SystemSources

	// UploadFiles is the upload directory the Storage page counts and deletes leftovers in; nil deletes rows
	// only and leaves bytes to the maintenance sweep.
	UploadFiles StorageFiles
}
