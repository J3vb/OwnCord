package admin

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/go-chi/chi/v5"
)

// handleBackup takes a manual backup. Only one runs at a time per API: a second POST is 409 BACKUP_RUNNING
// with no second VACUUM and no partial file. The scheduled backup skips this guard: its files have their own
// names and BackupToSafe publishes by atomic rename, so they cannot collide.
//
// A volume too short answers 507 STORAGE_LOW_DISK with the numbers; a landed backup refreshes the attention
// panel's backup signal at once.
func handleBackup(database *db.DB, paths backupPaths, gate *backupGate, attention *service.AttentionService) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !gate.running.CompareAndSwap(false, true) {
			writeErr(w, http.StatusConflict, httperr.CodeBackupRunning, "A backup is already being taken. Try again when it finishes.")
			return
		}
		defer gate.running.Store(false)
		// A big database outlasts the server's WriteTimeout and nothing is written until done: extend the deadline
		// like an archive, bounded by the same hard maximum.
		deadline := startArchive(w, r, func() {}, archiveProgressTimeout, archiveMaxLifetime)
		defer deadline.release()
		if hold := gate.hold.Load(); hold != nil {
			(*hold)()
		}
		backupDir := paths.dir
		if err := os.MkdirAll(backupDir, 0o750); err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to create backup directory")
			return
		}

		timestamp := time.Now().UTC().Format("20060102_150405")
		backupPath, err := freeBackupPath(backupDir, "chatserver_"+timestamp)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to choose a backup name")
			return
		}

		// Detached like the restore path's safety backup. BackupToSafe publishes by atomic rename, so an
		// interrupted backup leaves a .tmp the listing ignores, not a truncated .db it would present as restorable.
		// Rooted at SetupOptions.BackupDir.
		if err := database.BackupToSafe(context.WithoutCancel(r.Context()), backupPath, backupDir); err != nil {
			writeBackupFailure(w, err, "backup failed")
			return
		}

		// Verify before reporting success: a backup failing integrity_check is worse than none, as the operator
		// believes they have one.
		if err := db.CheckBackupIntegrity(context.WithoutCancel(r.Context()), backupPath); err != nil {
			slog.Error("backup failed integrity check — removing", "path", backupPath, "err", err)
			_ = os.Remove(backupPath)
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "backup failed verification")
			return
		}

		actor := actorFromContext(r)
		backupName := filepath.Base(backupPath)
		slog.Info("database backup created", "actor_id", actor, "name", backupName)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_create", "server", 0,
			fmt.Sprintf("backup saved: %s", backupName))

		attention.RefreshBackup(context.WithoutCancel(r.Context()), time.Now())

		writeJSON(w, http.StatusOK, map[string]string{
			"path":    filepath.Base(backupPath),
			"created": timestamp,
		})
	})
}

type backupEntry struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Date string `json:"date"`
}

func handleListBackups(paths backupPaths) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		backupDir := paths.dir
		entries, err := os.ReadDir(backupDir)
		if err != nil {
			if os.IsNotExist(err) {
				writeJSON(w, http.StatusOK, []backupEntry{})
				return
			}
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to list backups")
			return
		}

		var backups []backupEntry
		for _, e := range entries {
			if e.IsDir() || filepath.Ext(e.Name()) != ".db" ||
				isLiveDatabaseFile(filepath.Join(backupDir, e.Name()), paths.dbFile) {
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

		slices.SortFunc(backups, func(a, b backupEntry) int { return cmp.Compare(b.Date, a.Date) })

		writeJSON(w, http.StatusOK, backups)
	}
}

// resolveBackupName joins the {name} path parameter onto the backup directory, refusing a name that could
// leave it; false means the 400 is written.
func resolveBackupName(w http.ResponseWriter, r *http.Request, backupDir, dbFile string) (string, string, bool) {
	name := chi.URLParam(r, "name")
	if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid backup name")
		return "", "", false
	}
	target := filepath.Join(backupDir, name)
	if !strings.HasPrefix(target, backupDir+string(filepath.Separator)) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "invalid backup name")
		return "", "", false
	}
	if isLiveDatabaseFile(target, dbFile) {
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "that file is the live database, not a backup")
		return "", "", false
	}
	return name, target, true
}

func handleDeleteBackup(database *db.DB, paths backupPaths) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, target, ok := resolveBackupName(w, r, paths.dir, paths.dbFile)
		if !ok {
			return
		}

		if _, err := os.Stat(target); os.IsNotExist(err) { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "backup not found")
			return
		}

		if err := os.Remove(target); err != nil { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "failed to delete backup")
			return
		}

		actor := actorFromContext(r)
		slog.Info("backup deleted", "actor_id", actor, "name", name)
		db.WriteAudit(context.WithoutCancel(r.Context()), database, actor, "backup_delete", "server", 0, "deleted backup "+name)

		w.WriteHeader(http.StatusNoContent)
	})
}

// verifyRestoreSource refuses a backup that must not replace the live database and writes the error itself;
// it runs before the safety copy and before anything is closed.
func verifyRestoreSource(w http.ResponseWriter, r *http.Request, name, target string) bool {
	// Refuse a file SQLite itself rejects (truncated pre-crash backup, stray non-database .db): "restore
	// succeeded" then a broken server is the worst outcome.
	if err := db.CheckBackupIntegrity(context.WithoutCancel(r.Context()), target); err != nil {
		slog.Error("restore refused: backup failed integrity check", "backup", name, "err", err)
		writeErr(w, http.StatusBadRequest, httperr.CodeBadRequest, "backup file failed integrity verification")
		return false
	}

	// Refuse a backup a NEWER server wrote: it would put this older binary on a schema it has never seen and
	// boot silently on it.
	ahead, err := db.CheckBackupSchemaAhead(context.WithoutCancel(r.Context()), target)
	if err != nil {
		slog.Error("restore refused: could not read backup schema version", "backup", name, "err", err)
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "could not verify the backup's schema version")
		return false
	}
	if len(ahead) > 0 {
		slog.Warn("restore refused: backup schema is newer than this server", "backup", name, "unknown_migrations", strings.Join(ahead, ","))
		writeErr(w, http.StatusConflict, httperr.CodeSchemaTooNew,
			"backup was written by a newer server version; upgrade this server before restoring it")
		return false
	}
	return true
}

// restoreCarryTimeout bounds the live seq floor read in a restore request.
const restoreCarryTimeout = 10 * time.Second

// handleRestoreBackup verifies a backup and stages it for the next boot. It never writes over the open
// database: the staged copy and a marker (written last) are applied by db.ApplyStagedRestore before the
// database reopens, and the restart goes through normal shutdown.
func handleRestoreBackup(database *db.DB, paths backupPaths, gate *backupGate) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, target, ok := resolveBackupName(w, r, paths.dir, paths.dbFile)
		if !ok {
			return
		}

		// Serialize against a concurrent update apply and an already-requested restart. The deferred release is a
		// busy-to-idle CAS, so it covers every failure return and no-ops once commitRestartPending promoted the
		// state.
		if !beginRestartSensitiveOp() {
			writeRestartConflict(w)
			return
		}
		defer abortRestartSensitiveOp()
		// The safety copy of a big database outlasts the WriteTimeout; see handleBackup.
		deadline := startArchive(w, r, func() {}, archiveProgressTimeout, archiveMaxLifetime)
		defer deadline.release()
		if hold := gate.hold.Load(); hold != nil {
			(*hold)()
		}

		if _, err := os.Stat(target); os.IsNotExist(err) { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusNotFound, httperr.CodeNotFound, "backup not found")
			return
		}

		if !verifyRestoreSource(w, r, name, target) {
			return
		}

		dbPath := paths.dbFile
		ctx := context.WithoutCancel(r.Context())

		actor := actorFromContext(r)
		// Audit the restore BEFORE the safety copy and synchronously (LogAudit, not WriteAudit), so the row is
		// durable in the live database and the copy. Best-effort: a failed write is logged, never a reason to
		// refuse.
		if err := database.LogAudit(ctx, actor, "backup_restore", "server", 0,
			fmt.Sprintf("restoring backup %s", name)); err != nil {
			slog.Error("audit log write failed", "action", "backup_restore", "actor_id", actor, "error", err)
		}

		// Safety: pre-restore backup first. WithoutCancel so a canceled request ctx cannot skip it; paths.dir so it
		// lands beside the other backups.
		preRestore := filepath.Join(paths.dir, PreRestoreBackupPrefix+time.Now().UTC().Format("20060102_150405")+".db")
		if err := database.BackupToSafe(ctx, preRestore, paths.dir); err != nil {
			// Fail closed. The panel promises a pre-restore backup; proceeding without one removes the safety net
			// exactly when needed.
			slog.Error("pre-restore backup failed — aborting restore", "err", err)
			writeBackupFailure(w, err, "could not create the pre-restore safety backup — restore aborted, database untouched")
			return
		}
		// Nothing is restored on a refusal below, and the safety copy is kept from retention, so a retried refusal
		// would leave one database-sized file per attempt.
		dropSafetyCopy := func() {
			if err := os.Remove(preRestore); err != nil {
				slog.Warn("could not remove the unused pre-restore safety copy", "path", preRestore, "err", err)
			}
		}

		// Carry the live event sequence floor into the sidecar that outlives the swap, so the next boot reserves
		// its block above everything this server handed out. A floor that cannot be stored refuses the restore;
		// other trouble (unreadable live database) only warns.
		carryCtx, carryCancel := context.WithTimeout(ctx, restoreCarryTimeout)
		err := db.CarryWSSeqFloorForRestore(carryCtx, dbPath)
		carryCancel()
		if errors.Is(err, db.ErrWSSeqFloorNotStored) {
			slog.Error("restore refused: could not preserve the event sequence floor", "err", err)
			dropSafetyCopy()
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError,
				"could not preserve the event sequence floor — restore refused, database untouched")
			return
		}
		if err != nil {
			slog.Warn("restore: could not carry the live ws seq floor across the restore", "err", err)
		}

		marker := db.StagedRestoreMarker{
			Backup:      name,
			SafetyCopy:  filepath.Base(preRestore),
			RequestedAt: time.Now().UTC(),
			ActorID:     actor,
		}
		if err := db.StageRestore(ctx, dbPath, target, marker); err != nil {
			slog.Error("restore refused: could not stage the backup", "backup", name, "err", err)
			dropSafetyCopy()
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError,
				"could not stage the backup — database untouched")
			return
		}

		slog.Warn("restore staged — the next start applies it", "actor_id", actor, "backup", name)

		// The marker is committed. Trim old safety copies, protecting the new one and the restore source (an
		// operator undoing a bad restore restores from a pre_restore_ copy). A prune failure is logged, never
		// changes the outcome.
		if removed, pruneErr := PruneSafetyCopies(paths.dir, SafetyCopiesKept, preRestore, target); pruneErr != nil {
			slog.Warn("could not prune old safety copies", "dir", paths.dir, "error", pruneErr)
		} else if len(removed) > 0 {
			slog.Info("pruned old safety copies", "count", len(removed), "names", removed)
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "restore staged — server restarting",
			"backup":  name,
		})

		// Restart through normal shutdown: the coordinator sends one server_restart notice, drains requests and
		// closes the database, and the next start swaps the staged copy in.
		commitRestartPending()
		go requestRestart("backup_restore")
	})
}

// writeBackupFailure answers a failed BackupToSafe: a copy refused for space is 507 STORAGE_LOW_DISK with the
// db error's numbers, anything else a 500 carrying what alone.
func writeBackupFailure(w http.ResponseWriter, err error, what string) {
	if !errors.Is(err, db.ErrBackupNoSpace) {
		writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, what)
		return
	}
	writeErr(w, http.StatusInsufficientStorage, httperr.CodeStorageLowDisk,
		what+": "+err.Error()+". Free some space on the backup volume, or delete old backups, and try again.")
}
