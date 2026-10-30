package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// openDatabase validates the configured backend and opens the database;
// App.startDatabase registers its close before migrating, so a migration
// failure still releases the handle.
func openDatabase(cfg *config.Config) (*db.DB, error) {
	// SQLite is the only supported backend.
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
// migrations and clears state left over from a previous run.
func initDatabase(log *slog.Logger, cfg *config.Config, database *db.DB, rc *RestartCoordinator) error {
	// Admin restart requests (update apply, backup restore, setup wizard) land
	// in the coordinator; wired before the listener starts serving, so no
	// request can hit the unwired default hook.
	admin.SetRestartHandoff(rc.Request)

	backup, err := backupBeforePendingMigrations(log, database, cfg.Database.Path, admin.ResolveBackupDir(cfg.Backup.Dir))
	if err != nil {
		return err
	}

	if err := db.Migrate(database); err != nil {
		return fmt.Errorf("running migrations: %w", err)
	}
	if backup != "" {
		// Actor 0 = system, the same convention the scheduled backup uses.
		db.WriteAudit(context.Background(), database, 0, "backup_create", "server", 0,
			"pre-migration backup saved: "+backup)
	}

	// Clear stale state from a previous run or crash; startup work with no
	// context to inherit.
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

// backupBeforePendingMigrations writes a verified copy of the live database
// before a pending migration moves the schema. Compose tracks :latest, so a
// routine `docker compose pull` would upgrade the schema with no safety copy;
// this is that copy, named for the first migration it precedes.
//
// It fails closed: a boot with migrations pending whose backup cannot be
// written is refused, because the promise is that the schema never moves
// unbacked-up (a read-only file, full disk or bad path is the operator's to
// fix). It writes into backupDir (backup.dir) beside the manual backups,
// before db.Migrate and before any goroutine serves. It returns the backup's
// file name, or "" when nothing was pending.
func backupBeforePendingMigrations(log *slog.Logger, database *db.DB, dbPath, backupDir string) (string, error) {
	// In-memory and fresh databases have no file to copy or no pending
	// migrations; PendingMigrations returns nil for both, which keeps
	// BackupToSafe off those paths.
	pending, err := db.PendingMigrations(database)
	if err != nil {
		return "", fmt.Errorf("checking for pending migrations: %w", err)
	}
	if len(pending) == 0 {
		return "", nil
	}

	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		return "", fmt.Errorf("pre-migration backup: creating %s: %w", backupDir, err)
	}

	// Name the copy for the first migration it precedes. A same-name copy may
	// predate a rollback and hold none of the data written since, so a new copy
	// goes under the first free _N suffix whenever the database changed after
	// the newest one; an earlier copy is never touched. A boot loop on a
	// migration that keeps failing changes nothing, so it reuses the newest
	// copy instead of filling the disk.
	name := admin.PreMigrateBackupPrefix + strings.TrimSuffix(filepath.Base(pending[0]), ".sql")
	path := filepath.Join(backupDir, name+".db")
	newest := ""
	var newestTime time.Time
	for n := 2; ; n++ {
		fi, statErr := os.Stat(path)
		if statErr != nil {
			break
		}
		newest, newestTime = path, fi.ModTime()
		path = filepath.Join(backupDir, fmt.Sprintf("%s_%d.db", name, n))
	}

	ctx := context.Background()
	if newest != "" && !changedSince(dbPath, newestTime) && db.CheckBackupIntegrity(ctx, newest) == nil {
		log.Info("pre-migration backup is current; reusing it",
			"path", filepath.Base(newest), "migrations", len(pending))
		return filepath.Base(newest), nil
	}

	if err := database.BackupToSafe(ctx, path, backupDir); err != nil {
		return "", fmt.Errorf("pre-migration backup: %w", err)
	}
	if err := db.CheckBackupIntegrity(ctx, path); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("pre-migration backup failed verification: %w", err)
	}

	log.Warn("pre-migration backup written before applying migrations",
		"path", filepath.Base(path), "migrations", len(pending))

	// The new copy is verified: trim older safety copies, never this one. A
	// prune failure must not refuse the boot. The prune covers both prefixes
	// and protects only the new pre_migrate_ copy.
	if removed, pruneErr := admin.PruneSafetyCopies(backupDir, admin.SafetyCopiesKept, path); pruneErr != nil {
		log.Warn("could not prune old safety copies", "dir", backupDir, "error", pruneErr)
	} else if len(removed) > 0 {
		log.Info("pruned old safety copies", "count", len(removed), "names", removed)
	}
	return filepath.Base(path), nil
}

// changedSince reports whether the database at dbPath may hold writes newer
// than t: its main file or a non-empty WAL was modified after t. An unreadable
// main file counts as changed.
func changedSince(dbPath string, t time.Time) bool {
	fi, err := os.Stat(dbPath)
	if err != nil || fi.ModTime().After(t) {
		return true
	}
	wal, err := os.Stat(dbPath + "-wal")
	return err == nil && wal.Size() > 0 && wal.ModTime().After(t)
}

// recordRestoreResult reports the staged backup restore the boot-time apply
// (db.ApplyStagedRestore, run by db.Open) handled: it reads the result file,
// writes one audit row, removes the file and returns the outcome for the
// attention panel (zero when no restore is pending). The file is removed only
// after the audit row, so a crash between the two repeats the row rather than
// losing the report.
func recordRestoreResult(log *slog.Logger, dbPath string, database *db.DB) service.RestoreOutcome {
	res, found, err := db.ReadRestoreResult(dbPath)
	if err != nil {
		log.Error("staged restore result is unreadable", "error", err)
		if clearErr := db.ClearRestoreResult(dbPath); clearErr != nil {
			log.Warn("staged restore result could not be removed", "error", clearErr)
		}
		return service.RestoreOutcome{}
	}
	if !found {
		return service.RestoreOutcome{}
	}
	action, detail := "backup_restore_applied", "restored backup "+res.Backup
	switch res.Status {
	case db.RestoreStatusApplied:
		log.Warn("staged restore applied", "backup", res.Backup)
	case db.RestoreStatusRolledBack:
		action, detail = "backup_restore_rolled_back", "restore of "+res.Backup+" failed, previous database kept: "+res.Error
		log.Error("staged restore rolled back", "backup", res.Backup, "reason", res.Error)
	default:
		action, detail = "backup_restore_refused", "restore of "+res.Backup+" refused, previous database kept: "+res.Error
		log.Error("staged restore refused", "backup", res.Backup, "reason", res.Error)
	}
	if err := database.LogAudit(context.Background(), res.ActorID, action, "server", 0, detail); err != nil {
		// The result file is kept so the next boot retries the audit row.
		log.Error("staged restore audit write failed", "action", action, "error", err)
	} else if err := db.ClearRestoreResult(dbPath); err != nil {
		log.Warn("staged restore result could not be removed", "error", err)
	}
	return service.RestoreOutcome{Recorded: true, Status: res.Status, Backup: res.Backup, At: res.AppliedAt, Reason: res.Error}
}
