package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
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
func MaintainBackups(ctx context.Context, database *db.DB, settings *service.SettingsService, backupDir string) error {
	schedule, err := settings.Setting(ctx, "backup_schedule")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("MaintainBackups: reading backup_schedule: %w", err)
	}

	interval := service.BackupScheduleInterval(schedule)
	var firstErr error
	if interval > 0 {
		if err := runScheduledBackup(ctx, database, backupDir, interval); err != nil {
			slog.Warn("scheduled backup failed", "error", err)
			firstErr = err
		}
	}

	if err := pruneExpiredBackups(ctx, database, settings, backupDir); err != nil {
		slog.Warn("backup retention pruning failed", "error", err)
		if firstErr == nil {
			firstErr = err
		}
	}
	pruneStaleBackupTemps(backupDir)
	return firstErr
}

// staleBackupTempAge is how long a backup's ".tmp" file must sit untouched
// before the sweep treats it as the leftover of a killed run: the shortest
// schedule interval, far longer than any VACUUM INTO keeps a temp unwritten.
const staleBackupTempAge = 24 * time.Hour

// pruneStaleBackupTemps removes the ".tmp" files killed backups left behind,
// along with SQLite's ".tmp-journal" sidecar VACUUM INTO writes beside each,
// and the work dirs of archive builds a killed process never cleaned up.
// BackupToSafe removes its temp on every error it returns, so only a process
// that died mid-VACUUM leaves one, and no *.db scan would ever reclaim it.
func pruneStaleBackupTemps(backupDir string) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-staleBackupTempAge)
	removed := 0
	for _, e := range entries {
		ext := filepath.Ext(e.Name())
		archiveWork := e.IsDir() && strings.HasPrefix(e.Name(), archiveWorkPrefix)
		if !archiveWork && (e.IsDir() || (ext != ".tmp" && ext != ".tmp-journal")) {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		path := filepath.Join(backupDir, e.Name())
		if rmErr := os.RemoveAll(path); rmErr != nil {
			slog.Warn("backup maintenance: failed to remove stale backup temp", "path", path, "error", rmErr)
			continue
		}
		removed++
	}
	if removed > 0 {
		slog.Info("backup maintenance: removed stale backup temp files", "count", removed)
	}
}

// freeBackupPath returns a path in backupDir for a backup named base (plus
// ".db"), with a "_N" suffix when that name is taken. VACUUM INTO refuses an
// existing destination and the timestamp only has second resolution, so two
// backups in one second need distinct names rather than a failure.
func freeBackupPath(backupDir, base string) (string, error) {
	path := filepath.Join(backupDir, base+".db")
	for i := 2; ; i++ {
		if _, err := os.Stat(path); err != nil {
			// ENOENT is the free-slot case. Any OTHER stat error (EACCES on
			// the dir, an unreadable mount) cannot be fixed by trying more
			// suffixes — stop probing and let VACUUM INTO surface the real
			// failure with a legible error instead of spinning this loop.
			return path, nil //nolint:nilerr // a stat error means the slot is usable or unfixable by suffixing; see above
		}
		if i > 100 {
			return "", fmt.Errorf("backup: no free filename after %s (tried 100 suffixes)", base)
		}
		path = filepath.Join(backupDir, fmt.Sprintf("%s_%d.db", base, i))
	}
}

// runScheduledBackup takes a backup when the newest existing one is older
// than interval (or none exists).
func runScheduledBackup(ctx context.Context, database *db.DB, backupDir string, interval time.Duration) error {
	newest, _, err := scanBackups(backupDir)
	if err != nil {
		return err
	}
	if !newest.IsZero() && time.Since(newest) < interval {
		return nil
	}

	if err := os.MkdirAll(backupDir, 0o750); err != nil {
		return fmt.Errorf("creating backup dir: %w", err)
	}
	base := "scheduled_" + time.Now().UTC().Format("20060102_150405")
	path, err := freeBackupPath(backupDir, base)
	if err != nil {
		return err
	}
	if err := database.BackupToSafe(ctx, path, backupDir); err != nil {
		return err
	}
	if err := db.CheckBackupIntegrity(ctx, path); err != nil {
		_ = os.Remove(path)
		return fmt.Errorf("scheduled backup failed verification: %w", err)
	}

	name := filepath.Base(path)
	slog.Info("scheduled backup created", "name", name)
	// Actor 0 = system, same audit action the manual handler writes.
	db.WriteAudit(ctx, database, 0, "backup_create", "server", 0, "scheduled backup saved: "+name)
	return nil
}

// PreRestoreBackupPrefix names the safety copy handleRestoreBackup (and the
// restore CLI) writes immediately before overwriting the live database. Those
// copies are not retention history: an operator needs the pre-restore state
// precisely when they are recovering from a bad restore, which may be long
// after the retention window, so the day-based retention never removes them.
// PruneSafetyCopies bounds them by count instead.
const PreRestoreBackupPrefix = "pre_restore_"

// PreMigrateBackupPrefix names the safety copy the boot path writes before a
// pending migration moves the schema (internal/app/database.go). Like the
// pre_restore_ copies it is the rollback target for a schema move, so the
// day-based retention never removes it; PruneSafetyCopies bounds it by count.
const PreMigrateBackupPrefix = "pre_migrate_"

// SafetyCopiesKept is how many pre_restore_ and pre_migrate_ copies, each,
// survive a prune.
const SafetyCopiesKept = 3

// removeSafetyCopy is the removal PruneSafetyCopies performs; a variable so a
// test can make one removal fail.
var removeSafetyCopy = os.Remove

// SetRemoveSafetyCopyForTest replaces the removal PruneSafetyCopies performs
// and returns a function that restores the previous one. It exists so tests in
// other packages can exercise the prune-failure path; production code must not
// call it.
func SetRemoveSafetyCopyForTest(fn func(string) error) (restore func()) {
	prev := removeSafetyCopy
	removeSafetyCopy = fn
	return func() { removeSafetyCopy = prev }
}

// isSafetyCopy reports whether a backup file name is a safety copy rather
// than retention history. Both the pre-restore and pre-migration prefixes
// count; day-based retention must never prune either (PruneSafetyCopies does,
// by count).
func isSafetyCopy(name string) bool {
	base := filepath.Base(name)
	return strings.HasPrefix(base, PreRestoreBackupPrefix) || strings.HasPrefix(base, PreMigrateBackupPrefix)
}

// PruneSafetyCopies keeps the newest keep top-level *.db files of each safety
// prefix (pre_restore_, pre_migrate_) in dir and removes the rest. Newest is by
// mtime, with the name as the tie-break (not name order alone: _10 sorts before
// _2, and a rollback re-upgrade breaks it). Paths in protect are never removed.
// keep < 1 is treated as 1. A missing dir is not an error. Every failed removal
// is reported (joined) after the loop has tried all of them; the caller treats
// the error as advisory.
func PruneSafetyCopies(dir string, keep int, protect ...string) (removed []string, err error) {
	if keep < 1 {
		keep = 1
	}
	entries, rdErr := os.ReadDir(dir)
	if rdErr != nil {
		if errors.Is(rdErr, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("prune safety copies: reading %s: %w", dir, rdErr)
	}
	isProtected := protectedMatcher(protect)
	for _, prefix := range []string{PreRestoreBackupPrefix, PreMigrateBackupPrefix} {
		names := safetyCopiesNewestFirst(entries, prefix)
		if len(names) <= keep {
			continue
		}
		var errs []error
		for _, name := range names[keep:] {
			path := filepath.Join(dir, name)
			if isProtected(path) {
				continue
			}
			if rmErr := removeSafetyCopy(path); rmErr != nil {
				errs = append(errs, fmt.Errorf("removing %s: %w", path, rmErr))
				continue
			}
			removed = append(removed, name)
		}
		err = errors.Join(err, errors.Join(errs...))
	}
	return removed, err
}

// protectedMatcher reports whether a candidate path is one of protect. It
// compares file identity as well as the cleaned absolute path: path strings
// differ by case on Windows (d:\ vs D:\) and through symlinks or hard links,
// and a restore source must never be deleted because its spelling differed.
func protectedMatcher(protect []string) func(path string) bool {
	paths := make(map[string]bool, len(protect))
	var infos []os.FileInfo
	for _, p := range protect {
		if abs, absErr := filepath.Abs(p); absErr == nil {
			paths[filepath.Clean(abs)] = true
		} else {
			paths[filepath.Clean(p)] = true
		}
		if fi, statErr := os.Stat(p); statErr == nil {
			infos = append(infos, fi)
		}
	}
	return func(path string) bool {
		abs, absErr := filepath.Abs(path)
		if absErr != nil {
			abs = path
		}
		if paths[filepath.Clean(abs)] {
			return true
		}
		fi, statErr := os.Stat(path)
		return statErr == nil && slices.ContainsFunc(infos, func(pi os.FileInfo) bool { return os.SameFile(pi, fi) })
	}
}

// safetyCopiesNewestFirst lists the top-level prefix*.db files among entries,
// newest mtime first, name descending as the tie-break.
func safetyCopiesNewestFirst(entries []os.DirEntry, prefix string) []string {
	type copyInfo struct {
		name  string
		mtime time.Time
	}
	var copies []copyInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), prefix) || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		copies = append(copies, copyInfo{name: e.Name(), mtime: info.ModTime()})
	}
	sort.Slice(copies, func(i, j int) bool {
		if !copies[i].mtime.Equal(copies[j].mtime) {
			return copies[i].mtime.After(copies[j].mtime)
		}
		return copies[i].name > copies[j].name
	})
	names := make([]string, len(copies))
	for i, c := range copies {
		names[i] = c.name
	}
	return names
}

// pruneExpiredBackups deletes *.db backups whose mtime is older than the
// backup_retention window (in days), always keeping the newest one and never
// touching the pre_restore_* or pre_migrate_* safety copies.
func pruneExpiredBackups(ctx context.Context, database *db.DB, settings *service.SettingsService, backupDir string) error {
	retStr, err := settings.Setting(ctx, "backup_retention")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("reading backup_retention: %w", err)
	}
	// Malformed values parse to 0; zero-or-below or above db.RetentionMaxDays
	// means retention is off. The write path now validates the value, but the
	// check stays as defence in depth (a value hand-edited into the settings
	// table, or written by a future path) so it disables pruning rather than
	// failing the maintenance tick or, worse, overflowing the cutoff below
	// into the future and unlinking every backup but the newest (the
	// message-retention window fails the same way over the identical
	// -days*24h arithmetic).
	days, _ := strconv.Atoi(strings.TrimSpace(retStr))
	if days <= 0 || days > db.RetentionMaxDays {
		return nil
	}

	newest, entries, err := scanBackups(backupDir)
	if err != nil || len(entries) == 0 {
		return err
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	pruned := 0
	for _, e := range entries {
		if isSafetyCopy(e.path) {
			continue
		}
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

// NewestBackup returns the newest backup's mtime — the last successful
// backup, since a failed one never leaves a file behind — or the zero time
// when there is none. The admin attention panel reads it.
func NewestBackup(backupDir string) (time.Time, error) {
	newest, _, err := scanBackups(backupDir)
	return newest, err
}

type backupFile struct {
	path  string
	mtime time.Time
}

// scanBackups lists *.db files in the backup dir, returning the newest mtime
// and all entries. A missing directory is "no backups", not an error.
func scanBackups(backupDir string) (newest time.Time, files []backupFile, err error) {
	entries, err := os.ReadDir(backupDir)
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
		files = append(files, backupFile{path: filepath.Join(backupDir, e.Name()), mtime: mt})
		if mt.After(newest) {
			newest = mt
		}
	}
	return newest, files, nil
}
