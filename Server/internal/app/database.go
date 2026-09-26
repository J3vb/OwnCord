package app

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
)

// openDatabase validates the configured backend and opens the database.
// The database stage; App.startDatabase registers its close before
// migrating, so a migration failure still releases the handle.
func openDatabase(cfg *config.Config) (*db.DB, error) {
	// SQLite is the only supported backend; the unfinished Postgres
	// scaffolding (stubbed query layer, never wired into the runtime) was
	// removed rather than completed.
	if t := cfg.Database.Type; t != "" && t != "sqlite" {
		return nil, fmt.Errorf("database.type=%q is not supported; set \"sqlite\" or omit it", t)
	}

	database, err := db.OpenWithMaxReaders(cfg.Database.Path, cfg.Database.MaxReaders)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}

	return database, nil
}

// initDatabase points the admin panel at the live database, runs the
// migrations and clears state left over from a previous run. Extracted from
// run.
func initDatabase(log *slog.Logger, cfg *config.Config, database *db.DB, rc *RestartCoordinator) error {
	// The admin "Restore backup" handler needs the real database file path:
	// without this, it falls back to a hardcoded "data/chatserver.db" and
	// silently no-ops on any server with a configured database.path.
	admin.SetDatabasePath(cfg.Database.Path)
	// Backup handlers and the scheduled-backup maintenance write to the
	// configured backup directory (defaults to data/backups).
	admin.SetBackupDir(cfg.Backup.Dir)
	// Admin restart requests (update apply, backup restore, setup wizard)
	// land in the coordinator, which drains this process and lets main()
	// perform the handoff. Wired before the listener starts serving, so no
	// admin request can ever hit the unwired default hook.
	admin.SetRestartHandoff(rc.Request)

	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}

	// Clear stale state from a previous run or crash. Startup work — nothing
	// to inherit a context from yet.
	if err := database.ResetAllUserStatuses(context.Background()); err != nil {
		log.Warn("failed to reset stale user statuses", "error", err)
	} else {
		log.Info("reset all user statuses to offline")
	}
	if err := database.ClearAllVoiceStates(context.Background()); err != nil {
		log.Warn("failed to clear stale voice states", "error", err)
	} else {
		log.Info("cleared stale voice states")
	}

	return nil
}
