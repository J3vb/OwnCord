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

// MaintainBackups implements the backup_schedule / backup_retention settings, driven by the 15-minute
// maintenance loop: it takes a scheduled backup when the newest on disk is older than the schedule interval
// and prunes past the retention window.
//
// Freshness is the newest scheduled or manual backup's mtime; the pre_restore_ and pre_migrate_ safety copies
// do not count, because each is the state before a restore or migration, not a backup of what runs now.
// Retention prunes by mtime in whole days but never removes the newest backup, so a long-dead schedule cannot
// delete the last copy.
//
// The returned error feeds the loop's circuit breaker; absent settings (fresh DB mid-migration) are not an
// error.
func MaintainBackups(ctx context.Context, database *db.DB, settings *service.SettingsService, backupDir, dbFile string) error {
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
		if err := runScheduledBackup(ctx, database, backupDir, dbFile, interval); err != nil {
			slog.Warn("scheduled backup failed", "error", err)
			firstErr = err
		}
	}

	if err := pruneExpiredBackups(ctx, database, settings, backupDir, dbFile); err != nil {
		slog.Warn("backup retention pruning failed", "error", err)
		if firstErr == nil {
			firstErr = err
		}
	}
	pruneStaleBackupTemps(backupDir)
	return firstErr
}

// staleBackupTempAge is how long a ".tmp" must sit untouched before the sweep treats it as a killed run's
// leftover: the shortest schedule interval, far longer than VACUUM INTO keeps a temp unwritten.
const staleBackupTempAge = 24 * time.Hour

// pruneStaleBackupTemps removes ".tmp" files and SQLite ".tmp-journal" sidecars that killed backups left, and
// orphaned archive work dirs. BackupToSafe removes its temp on every error, so only a process that died
// mid-VACUUM leaves one, and no *.db scan would reclaim it.
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

// freeBackupPath returns a path for a backup named base (plus ".db"), with a "_N" suffix when taken: VACUUM
// INTO refuses an existing destination and timestamps have second resolution.
func freeBackupPath(backupDir, base string) (string, error) {
	path := filepath.Join(backupDir, base+".db")
	for i := 2; ; i++ {
		if _, err := os.Stat(path); err != nil {
			// ENOENT is the free slot. Any OTHER stat error (EACCES, unreadable mount) is not fixed by more suffixes:
			// stop probing and let VACUUM INTO surface it.
			return path, nil //nolint:nilerr // a stat error means the slot is usable or unfixable by suffixing; see above
		}
		if i > 100 {
			return "", fmt.Errorf("backup: no free filename after %s (tried 100 suffixes)", base)
		}
		path = filepath.Join(backupDir, fmt.Sprintf("%s_%d.db", base, i))
	}
}

// runScheduledBackup takes a backup when the newest existing one is older than interval (or none exists).
func runScheduledBackup(ctx context.Context, database *db.DB, backupDir, dbFile string, interval time.Duration) error {
	newest, _, err := scanBackups(backupDir, dbFile)
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

// PreRestoreBackupPrefix names the safety copy written just before a restore overwrites the live database. An
// operator may need it long after the retention window, so day-based retention never removes it;
// PruneSafetyCopies bounds it by count.
const PreRestoreBackupPrefix = "pre_restore_"

// PreMigrateBackupPrefix names the safety copy written before a pending migration moves the schema. It is the
// rollback target, so day-based retention never removes it; PruneSafetyCopies bounds it by count.
const PreMigrateBackupPrefix = "pre_migrate_"

// SafetyCopiesKept is how many pre_restore_ and pre_migrate_ copies, each, survive a prune.
const SafetyCopiesKept = 3

// removeSafetyCopy is a var so a test can make one removal fail.
var removeSafetyCopy = os.Remove

// SetRemoveSafetyCopyForTest replaces the removal and returns a func restoring it. Tests only: production
// code must not call it.
func SetRemoveSafetyCopyForTest(fn func(string) error) (restore func()) {
	prev := removeSafetyCopy
	removeSafetyCopy = fn
	return func() { removeSafetyCopy = prev }
}

// isSafetyCopy reports whether a name is a safety copy; day-based retention must never prune either.
func isSafetyCopy(name string) bool {
	base := filepath.Base(name)
	return strings.HasPrefix(base, PreRestoreBackupPrefix) || strings.HasPrefix(base, PreMigrateBackupPrefix)
}

// PruneSafetyCopies keeps the newest keep top-level *.db files of each safety prefix in dir and removes the
// rest. Newest is by mtime with name as tie-break (not name order alone: _10 sorts before _2, and a rollback
// re-upgrade breaks it). Paths in protect are never removed. keep < 1 is treated as 1; a missing dir is not
// an error. Every failed removal is reported (joined) after trying all; the caller treats the error as
// advisory.
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

// protectedMatcher reports whether a path is one of protect, comparing file identity as well as the cleaned
// path: spellings differ by case on Windows and through symlinks or hard links, and a restore source must
// never be deleted over a spelling.
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

// pruneExpiredBackups deletes *.db backups older than the backup_retention window (days), always keeping the
// newest and never touching safety copies (scanBackups leaves them out).
func pruneExpiredBackups(ctx context.Context, database *db.DB, settings *service.SettingsService, backupDir, dbFile string) error {
	retStr, err := settings.Setting(ctx, "backup_retention")
	if err != nil {
		if errors.Is(err, db.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("reading backup_retention: %w", err)
	}
	// Malformed values parse to 0; zero-or-below or above db.RetentionMaxDays means retention off. The write
	// path validates, but a hand-edited settings row must disable pruning rather than overflow the cutoff into
	// the future and unlink every backup but the newest.
	days, _ := strconv.Atoi(strings.TrimSpace(retStr))
	if days <= 0 || days > db.RetentionMaxDays {
		return nil
	}

	newest, entries, err := scanBackups(backupDir, dbFile)
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

// NewestBackup returns the newest scheduled or manual backup's mtime (a failed backup leaves no file), or the
// zero time. Safety copies do not count.
func NewestBackup(backupDir, dbFile string) (time.Time, error) {
	newest, _, err := scanBackups(backupDir, dbFile)
	return newest, err
}

type backupFile struct {
	path  string
	mtime time.Time
}

// scanBackups lists the backup history: every *.db except safety copies, which the schedule, health signal
// and retention all leave out. It returns the newest mtime and all entries; a missing directory is "no
// backups", not an error. The live database and its sidecars are never listed, whatever folder backup.dir
// names.
func scanBackups(backupDir, dbFile string) (newest time.Time, files []backupFile, err error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return time.Time{}, nil, nil
		}
		return time.Time{}, nil, fmt.Errorf("reading backup dir: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".db" || isSafetyCopy(e.Name()) {
			continue
		}
		if isLiveDatabaseFile(filepath.Join(backupDir, e.Name()), dbFile) {
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
