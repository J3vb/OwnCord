package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

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

	if err := backupBeforePendingMigrations(log, cfg, database); err != nil {
		return err
	}

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

// preMigrateBackupPrefix names the boot-time safety copy taken before a
// pending migration moves the schema. It is distinct from the admin panel's
// pre_restore_ copies, and like them it is never a retention candidate.
const preMigrateBackupPrefix = "pre_migrate_"

// backupBeforePendingMigrations writes a verified copy of the live database
// before initDatabase lets a pending migration move the schema (O3). Compose
// tracks :latest, so a routine `docker compose pull` upgrades the schema with
// no safety copy; this is that copy, taken at boot and named for the first
// migration it precedes.
//
// It FAILS CLOSED: a boot with migrations pending whose backup cannot be
// written is refused, because the whole promise is that the schema never
// moves unbacked-up. A read-only file, a full disk or a bad path is the
// operator's to fix; booting anyway would silently trade the safety net away.
//
// It runs after admin.SetBackupDir so the copy lands beside the operator's
// manual backups, before db.Migrate so the copy predates the schema move, and
// before any goroutine serves — there is no context to inherit.
func backupBeforePendingMigrations(log *slog.Logger, cfg *config.Config, database *db.DB) error {
	// In-memory databases (tests, tooling) have no file to copy, and a fresh
	// database has no pending migrations — PendingMigrations returns nil for
	// both, but a file check keeps BackupToSafe out of the in-memory path.
	pending, err := db.PendingMigrations(database)
	if err != nil {
		return fmt.Errorf("checking for pending migrations: %w", err)
	}
	if len(pending) == 0 {
		return nil
	}

	backupDir := cfg.Backup.Dir
	if backupDir == "" {
		backupDir = filepath.Join("data", "backups")
	}
	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		return fmt.Errorf("pre-migration backup: creating %s: %w", backupDir, err)
	}

	// Name the copy for the first migration it precedes, so an operator can
	// see at a glance which schema move this protects.
	first := strings.TrimSuffix(filepath.Base(pending[0]), ".sql")
	path := filepath.Join(backupDir, preMigrateBackupPrefix+first+".db")

	ctx := context.Background()
	// A same-name copy can only mean a previous boot died between the backup
	// and the migration (once the migration applies, the first pending file
	// changes), so the copy it left is the pre-migration state and is reused
	// rather than overwritten. Verify it first: a process that died mid-write
	// can leave a file that is present but unusable, and a bad safety copy is
	// worse than none.
	if _, statErr := os.Stat(path); statErr == nil {
		if verifyErr := db.CheckBackupIntegrity(ctx, path); verifyErr == nil {
			log.Info("pre-migration backup already present; skipping", "path", path, "migrations", len(pending))
			return nil
		}
		log.Warn("pre-migration backup present but unreadable — retaking", "path", path)
		if rmErr := os.Remove(path); rmErr != nil {
			return fmt.Errorf("pre-migration backup: removing unreadable copy %s: %w", path, rmErr)
		}
	}

	if err := database.BackupToSafe(ctx, path, backupDir); err != nil {
		return fmt.Errorf("pre-migration backup: %w", err)
	}
	if err := db.CheckBackupIntegrity(ctx, path); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("pre-migration backup failed verification: %w", err)
	}

	log.Warn("pre-migration backup written before applying migrations",
		"path", filepath.Base(path), "migrations", len(pending))
	// Actor 0 = system, the same convention the scheduled backup uses.
	db.WriteAudit(ctx, database, 0, "backup_create", "server", 0,
		fmt.Sprintf("pre-migration backup saved: %s (%d migration(s) pending)", filepath.Base(path), len(pending)))
	return nil
}
