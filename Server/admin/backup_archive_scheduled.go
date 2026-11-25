package admin

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// scheduledArchivePrefix names the full archives the maintenance loop keeps in backup.dir; the list, the
// freshness check and the retention prune all look only at files named this way.
const scheduledArchivePrefix = "scheduled_"

const (
	// scheduledArchivesKept caps the stored full archives, whatever backup_retention says: each one holds
	// uploads, so they are the files that fill a disk.
	scheduledArchivesKept = 3
	// archiveDueSlack is one maintenance tick: an archive counts as due this much before a full interval.
	archiveDueSlack = 15 * time.Minute
	// scheduledArchiveRetry is the least wait before a failed archive is tried again.
	scheduledArchiveRetry = time.Hour
	// scheduledArchiveHeadroomPercent is free space a scheduled build leaves above server.min_free_disk_mb, as
	// a percent of its own size, so a backup never eats the room uploads need.
	scheduledArchiveHeadroomPercent = 10
	// maxArchiveReasonLen bounds the failure text kept for the attention panel.
	maxArchiveReasonLen = 300
)

// archiveDataDBEntry is the database's place in every archive; a stored archive without it is not a backup.
const archiveDataDBEntry = "data/chatserver.db"

// scheduledArchives is the one scheduled archive job of the process. It is package state, like archiveBusy
// which it shares with the manual download, so both the maintenance loop and the attention panel see it.
var scheduledArchives = &scheduledArchiveState{}

// scheduledArchiveState is what the scheduled archive job remembers between ticks: when it may try again, and
// the failure the attention panel reports.
type scheduledArchiveState struct {
	mu           syncutil.Mutex
	running      chan struct{} // closed when the current job ends; nil when none ran
	nextTry      time.Time
	failingSince time.Time
	failedAt     time.Time
	reason       string
}

// ArchiveStatus is the scheduled archive job's state for the attention panel. Newest is the stored archive's
// time (zero when none). FailingSince and FailedAt are zero while the last run succeeded.
type ArchiveStatus struct {
	Newest       time.Time
	FailingSince time.Time
	FailedAt     time.Time
	Reason       string
}

// ScheduledArchiveStatus reports the newest stored full archive in backupDir and the last failure.
func ScheduledArchiveStatus(backupDir string) (ArchiveStatus, error) {
	newest, _, err := scanArchives(backupDir)
	if err != nil {
		return ArchiveStatus{}, err
	}
	st := scheduledArchives
	st.mu.Lock()
	defer st.mu.Unlock()
	return ArchiveStatus{Newest: newest, FailingSince: st.failingSince, FailedAt: st.failedAt, Reason: st.reason}, nil
}

// WaitScheduledArchives waits for a running scheduled archive to end or ctx to finish. Shutdown calls it after
// cancelling the context the job runs under, before the database closes.
func WaitScheduledArchives(ctx context.Context) error {
	st := scheduledArchives
	st.mu.Lock()
	done := st.running
	st.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("scheduled archive still running: %w", ctx.Err())
	}
}

// scanArchives lists the stored scheduled full archives and the newest mtime; a missing directory is none.
func scanArchives(backupDir string) (newest time.Time, files []backupFile, err error) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return time.Time{}, nil, nil
		}
		return time.Time{}, nil, fmt.Errorf("reading backup dir: %w", err)
	}
	for _, e := range entries {
		if !isScheduledArchiveName(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		info, infoErr := e.Info()
		if infoErr != nil {
			continue
		}
		files = append(files, backupFile{path: filepath.Join(backupDir, e.Name()), mtime: info.ModTime()})
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	return newest, files, nil
}

// isScheduledArchiveName reports whether name is one of the archives the scheduled job stores.
func isScheduledArchiveName(name string) bool {
	return strings.HasPrefix(name, scheduledArchivePrefix) && strings.EqualFold(filepath.Ext(name), ".zip")
}

// startScheduledArchive begins a full archive when the newest stored one is older than interval, unless a
// failed run is still backing off or another archive (a manual download, or the previous scheduled run) holds
// archiveBusy. It never waits for the build: the job runs in its own goroutine under ctx, and the maintenance
// tick goes on, so other jobs and shutdown are not held up.
func startScheduledArchive(ctx context.Context, database *db.DB, settings *service.SettingsService, paths backupPaths, opts SetupOptions, interval time.Duration) error {
	if opts.RunningCfg == nil {
		return nil
	}
	newest, _, err := scanArchives(paths.dir)
	if err != nil {
		return err
	}
	// newest is when the last build ended, a tick or more after it became due: allow one tick of slack so the
	// archive does not slip later every interval.
	if !newest.IsZero() && time.Since(newest) < interval-archiveDueSlack {
		return nil
	}
	if ctx.Err() != nil {
		return nil // shutting down: start nothing the shutdown join has already passed
	}
	st := scheduledArchives
	st.mu.Lock()
	backingOff := time.Now().Before(st.nextTry)
	st.mu.Unlock()
	if backingOff {
		return nil
	}
	if !archiveBusy.CompareAndSwap(false, true) {
		slog.Info("scheduled archive skipped: another archive is being prepared")
		return nil
	}
	done := make(chan struct{})
	st.mu.Lock()
	st.running = done
	st.mu.Unlock()
	go st.run(ctx, done, database, settings, paths, opts)
	return nil
}

// run is the job's goroutine: it holds archiveBusy (taken by the caller) until it ends, and exits when ctx
// does or the build passes archiveMaxLifetime.
func (st *scheduledArchiveState) run(ctx context.Context, done chan struct{}, database *db.DB, settings *service.SettingsService, paths backupPaths, opts SetupOptions) {
	defer close(done)
	defer archiveBusy.Store(false)
	runCtx, cancel := context.WithTimeout(ctx, archiveMaxLifetime)
	defer cancel()

	// Older archives go first, down to one fewer than the cap, so the build has the room they held and the
	// folder never holds more than the cap. The newest always stays, so a failed build never leaves none.
	pruneArchivesFor(runCtx, database, settings, paths.dir, scheduledArchivesKept-1)
	name, size, err := storeScheduledArchive(runCtx, database, opts, paths)
	if err != nil {
		if ctx.Err() != nil {
			return // shutting down: the next start tries again, and this is not a failure to report
		}
		st.recordFailure(err, paths.dir)
		return
	}
	st.recordSuccess()
	slog.Info("scheduled archive created", "name", name, "bytes", size)
	// Actor 0 = system, as the .db backup writes.
	db.WriteAudit(runCtx, database, 0, "backup_create", "server", 0, "scheduled full archive saved: "+name)
	pruneArchivesFor(runCtx, database, settings, paths.dir, scheduledArchivesKept)
}

func (st *scheduledArchiveState) recordFailure(err error, backupDir string) {
	now := time.Now()
	reason := strings.ReplaceAll(err.Error(), backupDir, "<backup folder>")
	if len(reason) > maxArchiveReasonLen {
		reason = reason[:maxArchiveReasonLen] + "..."
	}
	st.mu.Lock()
	if st.failingSince.IsZero() {
		st.failingSince = now
	}
	st.failedAt, st.reason, st.nextTry = now, reason, now.Add(scheduledArchiveRetry)
	st.mu.Unlock()
	slog.Warn("scheduled archive failed", "error", err, "retry_after", scheduledArchiveRetry)
}

func (st *scheduledArchiveState) recordSuccess() {
	st.mu.Lock()
	st.failingSince, st.failedAt, st.reason, st.nextTry = time.Time{}, time.Time{}, "", time.Time{}
	st.mu.Unlock()
}

// storeScheduledArchive builds a full archive in a fresh work dir under backup.dir, checks it, and moves it
// into backup.dir under a name that is free. Any error removes the work dir, so no partial .zip is ever
// listed and the archive from the last good run stays.
func storeScheduledArchive(ctx context.Context, database *db.DB, opts SetupOptions, paths backupPaths) (name string, size int64, err error) {
	if err := os.MkdirAll(paths.dir, 0o750); err != nil {
		return "", 0, fmt.Errorf("creating backup dir: %w", err)
	}
	work, err := os.MkdirTemp(paths.dir, archiveWorkPrefix)
	if err != nil {
		return "", 0, fmt.Errorf("creating archive work dir: %w", err)
	}
	defer func() { _ = os.RemoveAll(work) }()

	built, err := buildArchiveWith(ctx, database, opts, paths, work, archiveBuildOptions{
		headroomPercent: scheduledArchiveHeadroomPercent,
		durable:         true,
	})
	if err != nil {
		return "", 0, err
	}
	if err := checkStoredArchive(built); err != nil {
		return "", 0, err
	}
	info, err := os.Stat(built)
	if err != nil {
		return "", 0, fmt.Errorf("reading archive size: %w", err)
	}
	dest, err := freeBackupPathExt(paths.dir, scheduledArchivePrefix+time.Now().UTC().Format("20060102_150405"), ".zip")
	if err != nil {
		return "", 0, err
	}
	if err := os.Rename(built, dest); err != nil {
		return "", 0, fmt.Errorf("storing archive: %w", err)
	}
	syncDir(paths.dir)
	return filepath.Base(dest), info.Size(), nil
}

// checkStoredArchive reopens the finished zip and confirms it carries the database: a cheap structure check
// that catches a zip a full disk or a bug cut short.
func checkStoredArchive(path string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("archive failed verification: %w", err)
	}
	defer zr.Close() //nolint:errcheck
	if !slices.ContainsFunc(zr.File, func(f *zip.File) bool { return f.Name == archiveDataDBEntry }) {
		return errors.New("archive failed verification: the database is missing from it")
	}
	return nil
}

// syncDir flushes a directory's new entry to disk after a rename. Best effort: the file is already in place,
// and some systems (Windows) cannot sync a directory.
func syncDir(dir string) {
	d, err := os.Open(dir) //nolint:gosec // G304: the backup directory itself
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}

// pruneArchivesFor removes stored archives past keep and the backup_retention window.
func pruneArchivesFor(ctx context.Context, database *db.DB, settings *service.SettingsService, backupDir string, keep int) {
	days, err := retentionDays(ctx, settings)
	if err != nil {
		slog.Warn("scheduled archive retention: could not read backup_retention", "error", err)
		days = 0
	}
	pruneArchives(ctx, database, backupDir, days, keep)
}

// pruneArchives keeps the newest keep archives at most, drops any older than days (when days > 0) beyond the
// newest, and never removes the newest. The cap holds when days is 0.
func pruneArchives(ctx context.Context, database *db.DB, backupDir string, days, keep int) {
	_, files, err := scanArchives(backupDir)
	if err != nil || len(files) == 0 {
		return
	}
	slices.SortFunc(files, func(a, b backupFile) int {
		if !a.mtime.Equal(b.mtime) {
			return b.mtime.Compare(a.mtime)
		}
		return strings.Compare(b.path, a.path)
	})
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	pruned := 0
	for i, f := range files {
		if i == 0 || (i < keep && (days <= 0 || !f.mtime.Before(cutoff))) {
			continue
		}
		if rmErr := os.Remove(f.path); rmErr != nil {
			slog.Warn("scheduled archive retention: failed to remove expired archive", "path", f.path, "error", rmErr)
			continue
		}
		pruned++
	}
	if pruned > 0 {
		slog.Info("scheduled archive retention: pruned archives", "count", pruned, "kept_at_most", keep)
		db.WriteAudit(ctx, database, 0, "backup_delete", "server", 0,
			fmt.Sprintf("retention pruned %d full archive(s)", pruned))
	}
}
