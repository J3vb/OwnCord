package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/owncord/server/db"
)

// Scheduled-backup intervals for the backup_schedule setting values the admin
// UI offers. "off" (or anything unrecognised) disables scheduling.
const (
	backupIntervalDaily  = 24 * time.Hour
	backupIntervalWeekly = 7 * 24 * time.Hour
)

// MaintainBackups implements the backup_schedule / backup_retention settings
// the admin panel has always offered. It is driven by main.go's 15-minute
// maintenance loop, mirroring the expired-session sweep: read the settings
// each tick, take a scheduled backup when the newest backup on disk is older
// than the schedule interval, and prune backups past the retention window.
//
// Freshness is judged by the newest *.db file's mtime, manual backups
// included — an operator who clicked "Backup now" this morning does not need
// a second copy tonight. Retention prunes by mtime in whole days, but never
// removes the newest backup, so a long-dead schedule cannot delete the last
// copy in the directory.
//
// The returned error feeds the maintenance loop's circuit breaker; settings
// simply not existing (fresh DB mid-migration) is not an error.
func MaintainBackups(ctx context.Context, database *db.DB) error {
	schedule, err := database.GetSetting(ctx, "backup_schedule")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("MaintainBackups: reading backup_schedule: %w", err)
	}

	var interval time.Duration
	switch strings.ToLower(strings.TrimSpace(schedule)) {
	case "daily":
		interval = backupIntervalDaily
	case "weekly":
		interval = backupIntervalWeekly
	}

	var firstErr error
	if interval > 0 {
		if err := runScheduledBackup(ctx, database, interval); err != nil {
			slog.Warn("scheduled backup failed", "error", err)
			firstErr = err
		}
	}

	if err := pruneExpiredBackups(ctx, database); err != nil {
		slog.Warn("backup retention pruning failed", "error", err)
		if firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// runScheduledBackup takes a backup when the newest existing one is older
// than interval (or none exists).
func runScheduledBackup(ctx context.Context, database *db.DB, interval time.Duration) error {
	newest, _, err := scanBackups()
	if err != nil {
		return err
	}
	if !newest.IsZero() && time.Since(newest) < interval {
		return nil
	}

	if err := os.MkdirAll(backupBaseDir, 0o750); err != nil {
		return fmt.Errorf("creating backup dir: %w", err)
	}
	// VACUUM INTO refuses an existing destination, and the timestamp only has
	// second resolution — suffix on collision instead of failing the tick.
	base := "scheduled_" + time.Now().UTC().Format("20060102_150405")
	name := base + ".db"
	path := filepath.Join(backupBaseDir, name)
	for i := 2; ; i++ {
		if _, err := os.Stat(path); err != nil {
			// ENOENT is the free-slot case. Any OTHER stat error (EACCES on
			// the dir, an unreadable mount) cannot be fixed by trying more
			// suffixes — stop probing and let VACUUM INTO surface the real
			// failure with a legible error instead of spinning this loop.
			break
		}
		if i > 100 {
			return fmt.Errorf("scheduled backup: no free filename after %s (tried 100 suffixes)", base)
		}
		name = fmt.Sprintf("%s_%d.db", base, i)
		path = filepath.Join(backupBaseDir, name)
	}
	if err := database.BackupToSafe(ctx, path, backupBaseDir); err != nil {
		return err
	}
	if err := db.CheckBackupIntegrity(ctx, path); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("scheduled backup failed verification: %w", err)
	}

	slog.Info("scheduled backup created", "name", name)
	// Actor 0 = system, same audit action the manual handler writes.
	db.WriteAudit(ctx, database, 0, "backup_create", "server", 0, "scheduled backup saved: "+name)
	return nil
}

// pruneExpiredBackups deletes *.db backups whose mtime is older than the
// backup_retention window (in days), always keeping the newest one.
func pruneExpiredBackups(ctx context.Context, database *db.DB) error {
	retStr, err := database.GetSetting(ctx, "backup_retention")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("reading backup_retention: %w", err)
	}
	// Malformed values parse to 0; zero-or-below means retention is off, so a
	// typo disables pruning rather than failing the maintenance tick.
	days, _ := strconv.Atoi(strings.TrimSpace(retStr))
	if days <= 0 {
		return nil
	}

	newest, entries, err := scanBackups()
	if err != nil || len(entries) == 0 {
		return err
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	pruned := 0
	for _, e := range entries {
		if e.mtime.Before(cutoff) && !e.mtime.Equal(newest) {
			if rmErr := os.Remove(e.path); rmErr != nil {
				slog.Warn("backup retention: failed to remove expired backup", "path", e.path, "error", rmErr)
				continue
			}
			pruned++
		}
	}
	if pruned > 0 {
		slog.Info("backup retention: pruned expired backups", "count", pruned, "retention_days", days)
		db.WriteAudit(ctx, database, 0, "backup_delete", "server", 0,
			fmt.Sprintf("retention pruned %d backup(s) older than %d days", pruned, days))
	}
	return nil
}

type backupFile struct {
	path  string
	mtime time.Time
}

// scanBackups lists *.db files in the backup dir, returning the newest mtime
// and all entries. A missing directory is "no backups", not an error.
func scanBackups() (newest time.Time, files []backupFile, err error) {
	entries, err := os.ReadDir(backupBaseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return time.Time{}, nil, nil
		}
		return time.Time{}, nil, fmt.Errorf("reading backup dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".db" {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		mt := info.ModTime()
		files = append(files, backupFile{path: filepath.Join(backupBaseDir, e.Name()), mtime: mt})
		if mt.After(newest) {
			newest = mt
		}
	}
	return newest, files, nil
}
