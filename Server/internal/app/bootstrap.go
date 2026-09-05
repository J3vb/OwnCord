package app

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
)

// removeOldBinary deletes the binary a previous self-update left behind.
// The data-dir stage's first act, before anything is opened.
func removeOldBinary(log *slog.Logger) {
	// Clean up old binary from a previous update. Bounded retry: in spawn
	// mode the predecessor spawns this process as its very last act, so for
	// the first few hundred milliseconds it may not have fully exited — and
	// on Windows its image file (the .old after the swap) stays locked until
	// it does.
	exePath, exeErr := os.Executable()
	if exeErr != nil {
		log.Warn("failed to determine executable path", "error", exeErr)
		return
	}

	oldPath := exePath + ".old"
	if _, statErr := os.Stat(oldPath); statErr != nil {
		return
	}

	var rmErr error
	for attempt := range 5 {
		if attempt > 0 {
			time.Sleep(250 * time.Millisecond)
		}
		if rmErr = os.Remove(oldPath); rmErr == nil {
			break
		}
	}
	if rmErr != nil {
		log.Warn("failed to remove old binary", "path", oldPath, "error", rmErr)
	} else {
		log.Info("removed old binary from previous update", "path", oldPath)
	}
}

// LoadConfig loads the on-disk configuration, applies its logging level
// and resolves the restart handoff mode. main() calls it before app.New:
// the level applies to main's own log sinks, and the mode is read back from
// the coordinator after Run returns.
func LoadConfig(log *slog.Logger, levelVar *slog.LevelVar, rc *RestartCoordinator) (*config.Config, error) {
	cfg, err := config.Load(config.DefaultPath)
	if err != nil {
		return nil, fmt.Errorf("loading config: %w", err)
	}

	// Apply the configured log level. The admin panel's live log view (ring
	// buffer) follows the same threshold — set logging.level to "debug" to
	// capture debug records there.
	if lvl, ok := config.ParseLevel(cfg.Logging.Level); ok {
		levelVar.Set(lvl)
	} else {
		log.Warn("unknown logging.level, keeping info", "value", cfg.Logging.Level)
	}

	// Resolve how a self-restart hands off (spawn the replacement vs exit
	// for a supervisor) now that config is loaded — main() reads it back
	// after Run() returns.
	rc.SetMode(resolveRestartMode(cfg.Server.RestartMode, log))

	return cfg, nil
}

// prepareDataDir creates the configured data directory and warns when the
// volumes the server writes to are low on free space. The data-dir stage.
func prepareDataDir(log *slog.Logger, cfg *config.Config) error {
	if mkdirErr := os.MkdirAll(cfg.Server.DataDir, 0o750); mkdirErr != nil {
		return fmt.Errorf("creating data dir %s: %w", cfg.Server.DataDir, mkdirErr)
	}

	// Disk-space awareness: the database (WAL growth included), uploads,
	// certs, and by default backups all live on this volume, and running it
	// dry breaks several of them at once. Probe errors are ignored — unknown
	// is not "full". /health repeats this check continuously at the same
	// floor, server.min_free_disk_mb, and the upload path refuses at it.
	critical := cfg.Server.MinFreeDiskBytes()
	warnLowDisk(log, "data dir", cfg.Server.DataDir, critical)
	if cfg.Backup.Dir != "" && cfg.Backup.Dir != filepath.Join(cfg.Server.DataDir, "backups") {
		warnLowDisk(log, "backup dir", cfg.Backup.Dir, critical)
	}
	// The upload path refuses at this floor on ITS volume (B5-2), so an
	// operator who mounted upload.storage_dir elsewhere hears about that
	// volume at boot rather than from users getting 507s.
	if cfg.Upload.StorageDir != "" && cfg.Upload.StorageDir != filepath.Join(cfg.Server.DataDir, "uploads") {
		warnLowDisk(log, "upload dir", cfg.Upload.StorageDir, critical)
	}

	return nil
}
