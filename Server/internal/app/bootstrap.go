package app

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/updater"
)

// removeOldBinaryFn is the self-update cleanup App.start invokes once every
// start stage has succeeded; a var so a test can observe when it runs.
var removeOldBinaryFn = removeOldBinary

// removeOldBinary deletes the binaries previous self-updates left behind.
func removeOldBinary(log *slog.Logger) {
	exePath, exeErr := updater.ExecutablePath()
	if exeErr != nil {
		log.Warn("failed to determine executable path", "error", exeErr)
		return
	}
	removeOldBinaryAt(exePath, log)
}

// removeOldBinaryAt removes exePath.old and every exePath.old-*, one attempt
// each. On Windows a binary that is still running cannot be removed (a
// predecessor staying behind on its console, see updater.SpawnReplacement, or
// one still exiting); it is left for a later start rather than waited on.
func removeOldBinaryAt(exePath string, log *slog.Logger) {
	entries, err := os.ReadDir(filepath.Dir(exePath))
	if err != nil {
		log.Warn("failed to list old binaries", "error", err)
		return
	}
	base := filepath.Base(exePath)
	for _, e := range entries {
		name := e.Name()
		if name != base+".old" && !strings.HasPrefix(name, base+".old-") {
			continue
		}
		oldPath := filepath.Join(filepath.Dir(exePath), name)
		if err := os.Remove(oldPath); err != nil {
			log.Info("old binary not removed yet, a later start retries", "path", oldPath, "error", err)
			continue
		}
		log.Info("removed old binary from previous update", "path", oldPath)
	}
}

// LoadConfig loads the on-disk configuration, applies its logging level and
// resolves the restart handoff mode. main() calls it before app.New: the level
// applies to main's own log sinks, and the mode is read back from the
// coordinator after Run returns. It also returns the boot log level, which
// app.New hands the admin API as the level the timed debug toggle reverts to.
func LoadConfig(log *slog.Logger, levelVar *slog.LevelVar, rc *RestartCoordinator) (*config.Config, slog.Level, error) {
	cfg, err := config.Load(config.DefaultPath)
	if err != nil {
		return nil, slog.LevelInfo, fmt.Errorf("loading config: %w", err)
	}

	// The admin panel's live log view follows the same threshold: set
	// logging.level to "debug" to capture debug records there.
	base := slog.LevelInfo
	if lvl, ok := config.ParseLevel(cfg.Logging.Level); ok {
		levelVar.Set(lvl)
		base = lvl
	} else {
		log.Warn("unknown logging.level, keeping info", "value", cfg.Logging.Level)
	}

	// Resolve how a self-restart hands off now that config is loaded; main()
	// reads it back after Run returns.
	rc.SetMode(resolveRestartMode(cfg.Server.RestartMode, log))

	return cfg, base, nil
}

// prepareDataDir creates the configured data directory and warns when the
// volumes the server writes to are low on free space.
func prepareDataDir(log *slog.Logger, cfg *config.Config) error {
	if mkdirErr := os.MkdirAll(cfg.Server.DataDir, 0o750); mkdirErr != nil {
		return fmt.Errorf("creating data dir %s: %w", cfg.Server.DataDir, mkdirErr)
	}

	// The database (WAL growth included), uploads, certs and by default backups
	// share this volume, and running it dry breaks several at once. Probe
	// errors are ignored (unknown is not full); /health repeats the check at
	// the same floor, server.min_free_disk_mb, and the upload path refuses at it.
	critical := cfg.Server.MinFreeDiskBytes()
	warnLowDisk(log, "data dir", cfg.Server.DataDir, critical)
	if cfg.Backup.Dir != "" && cfg.Backup.Dir != filepath.Join(cfg.Server.DataDir, "backups") {
		warnLowDisk(log, "backup dir", cfg.Backup.Dir, critical)
	}
	// The upload path refuses at this floor on its own volume, so an operator
	// who mounted upload.storage_dir elsewhere hears at boot, not from users
	// getting 507s.
	if cfg.Upload.StorageDir != "" && cfg.Upload.StorageDir != filepath.Join(cfg.Server.DataDir, "uploads") {
		warnLowDisk(log, "upload dir", cfg.Upload.StorageDir, critical)
	}

	return nil
}
