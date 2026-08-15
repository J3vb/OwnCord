package admin

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"syscall"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
	"github.com/owncord/server/updater"
)

const (
	// restartGraceDelay lets the HTTP response and the server_restart
	// broadcast reach clients before the process goes away.
	restartGraceDelay = 2 * time.Second
	// shutdownGraceDelay is how long SIGTERM gets before the os.Exit backstop.
	shutdownGraceDelay = 10 * time.Second
)

// backupBaseDir is the directory for backup files, resolved to an absolute
// path at package init time so handlers don't depend on the process CWD (L14).
// Overridden at startup via SetBackupDir with cfg.Backup.Dir.
var backupBaseDir string

func init() {
	backupBaseDir = absOrRaw(filepath.Join("data", "backups"))
}

// SetBackupDir points every backup handler and the scheduled-backup
// maintenance at the operator-configured directory. Call once at startup with
// cfg.Backup.Dir (main.go, next to SetDatabasePath); tests use it to isolate
// a temp dir. Mirrors SetDatabasePath: without it, a configured backup.dir
// would be ignored while backups keep landing in the default location.
func SetBackupDir(dir string) {
	if dir == "" {
		return
	}
	backupBaseDir = absOrRaw(dir)
}

func absOrRaw(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

// dbFilePath is the live SQLite database file that "Restore backup"
// overwrites. It defaults to the historical "data/chatserver.db" but must be
// pointed at cfg.Database.Path via SetDatabasePath before the server starts
// serving requests (main.go, right after db.Open): without that call, a
// server configured with a non-default database.path would open its real
// database at cfg.Database.Path while restore keeps copying backups over an
// unrelated (possibly newly created) file at the default path, reporting
// success while the live database is never touched.
var dbFilePath = filepath.Join("data", "chatserver.db")

// SetDatabasePath points the restore handler at the SQLite file the server
// actually opened. Call once at startup with cfg.Database.Path; tests use it
// to point restore at an isolated temp file.
func SetDatabasePath(path string) {
	dbFilePath = path
}

// ─── Backup Handlers ─────────────────────────────────────────────────────────

func handleBackup(database *db.DB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backupDir := backupBaseDir
		if err := os.MkdirAll(backupDir, 0o750); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create backup directory")
			return
		}

		timestamp := time.Now().UTC().Format("20060102_150405")
		backupPath := filepath.Join(backupDir, "chatserver_"+timestamp+".db")

		// Detached like the restore path's safety backup: an interrupted
		// VACUUM INTO leaves a truncated .db that handleListBackups would
		// present as restorable. BackupToSafe is rooted at the configured
		// backup dir (SetBackupDir), not the historical hardcoded default.
		if err := database.BackupToSafe(context.WithoutCancel(r.Context()), backupPath, backupDir); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "backup failed")
			return
		}

		// Verify before reporting success: a backup that fails integrity_check
		// is worse than no backup, because the operator believes they have one.
		if err := db.CheckBackupIntegrity(context.WithoutCancel(r.Context()), backupPath); err != nil {
			slog.Error("backup failed integrity check — removing", "path", backupPath, "err", err)
			_ = os.Remove(backupPath)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "backup failed verification")
			return
		}

		actor := actorFromContext(r)
		backupName := filepath.Base(backupPath)
		slog.Info("database backup created", "actor_id", actor, "name", backupName)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_create", "server", 0,
			fmt.Sprintf("backup saved: %s", backupName))

		writeJSON(w, http.StatusOK, map[string]string{
			"path":    filepath.Base(backupPath),
			"created": timestamp,
		})
	})
}

// backupEntry is the JSON shape returned by GET /admin/api/backups.
type backupEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Date string `json:"date"`
}

func handleListBackups() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		backupDir := backupBaseDir
		entries, err := os.ReadDir(backupDir)
		if err != nil {
			if os.IsNotExist(err) {
				writeJSON(w, http.StatusOK, []backupEntry{})
				return
			}
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to list backups")
			return
		}

		var backups []backupEntry
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".db" {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			backups = append(backups, backupEntry{
				Name: e.Name(),
				Size: info.Size(),
				Date: info.ModTime().UTC().Format(time.RFC3339),
			})
		}
		if backups == nil {
			backups = []backupEntry{}
		}

		// Sort newest first.
		sort.Slice(backups, func(i, j int) bool {
			return backups[i].Date > backups[j].Date
		})

		writeJSON(w, http.StatusOK, backups)
	}
}

func handleDeleteBackup(database *db.DB) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
			return
		}

		target := filepath.Join(backupBaseDir, name)
		if !strings.HasPrefix(target, backupBaseDir+string(filepath.Separator)) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
			return
		}

		if _, err := os.Stat(target); os.IsNotExist(err) { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}

		if err := os.Remove(target); err != nil { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to delete backup")
			return
		}

		actor := actorFromContext(r)
		slog.Info("backup deleted", "actor_id", actor, "name", name)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_delete", "server", 0, "deleted backup "+name)

		w.WriteHeader(http.StatusNoContent)
	})
}

func handleRestoreBackup(database *db.DB, hub HubBroadcaster) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := chi.URLParam(r, "name")
		if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
			return
		}

		target := filepath.Join(backupBaseDir, name)
		if !strings.HasPrefix(target, backupBaseDir+string(filepath.Separator)) {
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
			return
		}

		if _, err := os.Stat(target); os.IsNotExist(err) { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}

		// Refuse to overwrite the live database with a file SQLite itself
		// rejects — a truncated pre-crash backup, a stray non-database .db.
		// The pre-restore safety copy would make this survivable, but "restore
		// succeeded" followed by a broken server is still the worst UX here.
		if err := db.CheckBackupIntegrity(context.WithoutCancel(r.Context()), target); err != nil {
			slog.Error("restore refused: backup failed integrity check", "backup", name, "err", err)
			writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "backup file failed integrity verification")
			return
		}

		dbPath := dbFilePath

		actor := actorFromContext(r)
		// Audit the restore BEFORE the pre-restore safety copy is taken, and
		// synchronously (LogAudit, not WriteAudit): the restore overwrites the
		// live database file, so the only durable home for this row is the
		// pre_restore_* backup captured below — an entry enqueued on the async
		// WriteAudit path could still be sitting in the writer's buffer when
		// BackupTo snapshots the DB. Best-effort per policy D8: a failed write
		// is logged, never a reason to refuse the restore.
		if err := database.LogAudit(context.WithoutCancel(r.Context()), actor, "backup_restore", "server", 0,
			fmt.Sprintf("restoring backup %s", name)); err != nil {
			slog.Error("audit log write failed", "action", "backup_restore", "actor_id", actor, "error", err)
		}

		// Safety: create a pre-restore backup before overwriting. WithoutCancel:
		// the restore proceeds regardless of client disconnect (Close/copyFile
		// below are not ctx-aware), so the safety backup must not be skippable
		// by a canceled request ctx.
		// backupBaseDir, not a cwd-relative path: the safety copy has to land in
		// the same directory the rest of the backup handlers read and write, or
		// a server started from another working directory writes it somewhere
		// the operator will never find it.
		preRestore := filepath.Join(backupBaseDir, "pre_restore_"+time.Now().UTC().Format("20060102_150405")+".db")
		if err := database.BackupToSafe(context.WithoutCancel(r.Context()), preRestore, backupBaseDir); err != nil {
			// Fail closed. The admin panel promises "a pre-restore backup will
			// be created" before an irreversible overwrite; proceeding without
			// one takes away the safety net the operator was shown, exactly
			// when they need it (restoring the wrong or a corrupt backup).
			slog.Error("pre-restore backup failed — aborting restore", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR",
				"could not create the pre-restore safety backup — restore aborted, database untouched")
			return
		}

		// Notify clients that the server is restarting.
		hub.BroadcastServerRestart("backup_restore", 5)

		// Checkpoint the WAL and close the database connection before overwriting
		// to prevent corruption from concurrent writes (BUG-096).
		if _, checkpointErr := database.SQLDb().ExecContext(context.WithoutCancel(r.Context()), "PRAGMA wal_checkpoint(TRUNCATE)"); checkpointErr != nil {
			slog.Warn("pre-restore WAL checkpoint failed", "err", checkpointErr)
		}

		slog.Warn("database restored from backup — closing DB", "actor_id", actor, "backup", name)

		if err := database.Close(); err != nil {
			slog.Error("failed to close database before restore", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to close database")
			return
		}

		// Stream the backup file over the (now closed) database to avoid loading
		// the entire DB into memory (could be hundreds of MiB).
		if err := copyBackupFile(target, dbPath); err != nil {
			// copyFile truncates the destination with os.Create before it can know
			// whether the read will succeed, so the live database file is already
			// destroyed by the time we get here — and the DB is closed, so nothing
			// is holding the old contents. Put the safety copy back rather than
			// leaving the operator with a zero-byte database.
			slog.Error("restore copy failed — rolling back to the pre-restore safety copy", "backup", name, "err", err)
			msg := "failed to restore database file — the pre-restore safety copy was put back, server restarting"
			if rbErr := copyBackupFile(preRestore, dbPath); rbErr != nil {
				slog.Error("rollback from the pre-restore safety copy failed — recover manually",
					"safety_copy", preRestore, "err", rbErr)
				msg = "failed to restore database file AND failed to roll back — recover manually from " + filepath.Base(preRestore)
			}
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", msg)
			// The database was closed before the copy: this process cannot serve
			// anything more either way, so it must respawn exactly as it does on
			// the success path.
			go requestRestart("backup_restore_failed")
			return
		}

		slog.Warn("database file replaced — restarting to load the restored data", "backup", name)

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "database restored — server restarting",
			"backup":  name,
		})

		// The database is closed and the file underneath it has been swapped:
		// this process can serve nothing more. It used to stop here, leaving a
		// live server answering every request against a closed DB while the
		// response and the restart broadcast both claimed a restart was
		// happening. Respawn for real, the same way applying an update does.
		go requestRestart("backup_restore")
	})
}

// restartSelf is the process-restart hook, swappable in tests (which must not
// respawn or exit the test binary). Guarded because the swap happens on the
// test goroutine while the restore handler reads it from its own.
var (
	restartMu   sync.Mutex
	restartSelf = restartProcess
)

// requestRestart invokes the current restart hook.
func requestRestart(reason string) {
	restartMu.Lock()
	fn := restartSelf
	restartMu.Unlock()
	fn(reason)
}

// restartProcess spawns a fresh copy of this server and shuts the current one
// down. Mirrors the update-apply path (update_handlers.go): SIGTERM first so
// main.go's graceful shutdown runs, os.Exit as the backstop.
func restartProcess(reason string) {
	// Give the HTTP response and the restart broadcast a moment to flush.
	time.Sleep(restartGraceDelay)

	exePath, err := os.Executable()
	if err != nil {
		slog.Error("restart: cannot determine executable path — manual restart required",
			"reason", reason, "error", err)
		return
	}
	if resolved, symErr := filepath.EvalSymlinks(exePath); symErr == nil {
		exePath = resolved
	}
	if err := updater.SpawnDetached(exePath, os.Args[1:]); err != nil {
		slog.Error("restart: spawning the replacement process failed — manual restart required",
			"reason", reason, "error", err)
		return
	}

	slog.Info("restart: replacement process spawned, shutting down", "reason", reason)
	if p, findErr := os.FindProcess(os.Getpid()); findErr == nil {
		_ = p.Signal(syscall.SIGTERM)
		time.Sleep(shutdownGraceDelay)
	}
	os.Exit(0) //nolint:gocritic // backstop if the SIGTERM handler didn't exit
}

// copyBackupFile is the restore path's file-copy hook. It exists as a var so
// tests can inject the hard-to-simulate mid-copy failure (truncate-then-fail)
// the rollback branch exists for; production never swaps it.
var copyBackupFile = copyFile

// copyFile streams src to dst without loading the entire file into memory.
func copyFile(src, dst string) error {
	in, err := os.Open(src) //nolint:gosec // G703: src is from sanitized backup path
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer in.Close() //nolint:errcheck

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create destination: %w", err)
	}

	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy: %w", err)
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return fmt.Errorf("sync: %w", err)
	}
	return out.Close()
}
