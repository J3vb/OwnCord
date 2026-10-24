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
	"github.com/go-chi/chi/v5"
)

// ─── Backup Handlers ─────────────────────────────────────────────────────────

// handleBackup takes a manual backup. Only one runs at a time on this API: a
// second POST while one is in flight is a 409 BACKUP_RUNNING that starts no
// second VACUUM and leaves no partial file (WP 8.4c). The scheduled
// maintenance backup is a separate path and does not take this guard: its
// files have their own names and BackupToSafe publishes by atomic rename, so
// the two cannot collide.
func handleBackup(database *db.DB, paths backupPaths, gate *backupGate) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !gate.running.CompareAndSwap(false, true) {
			writeErr(w, http.StatusConflict, "BACKUP_RUNNING", "A backup is already being taken. Try again when it finishes.")
			return
		}
		defer gate.running.Store(false)
		if hold := gate.hold.Load(); hold != nil {
			(*hold)()
		}
		backupDir := paths.dir
		if err := os.MkdirAll(backupDir, 0o750); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to create backup directory")
			return
		}

		timestamp := time.Now().UTC().Format("20060102_150405")
		backupPath, err := freeBackupPath(backupDir, "chatserver_"+timestamp)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to choose a backup name")
			return
		}

		// Detached like the restore path's safety backup. BackupToSafe runs
		// the VACUUM on the reader pool and publishes the result with an
		// atomic rename, so an interrupted backup leaves a .tmp the listing
		// ignores rather than a truncated .db it would present as restorable.
		// It is rooted at the configured backup dir (SetupOptions.BackupDir), not
		// the historical hardcoded default.
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

func handleListBackups(paths backupPaths) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		backupDir := paths.dir
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
		slices.SortFunc(backups, func(a, b backupEntry) int { return cmp.Compare(b.Date, a.Date) })

		writeJSON(w, http.StatusOK, backups)
	}
}

// resolveBackupName reads the {name} path parameter and joins it onto the
// backup directory, refusing a name that could leave it. On false it has
// already written the 400.
func resolveBackupName(w http.ResponseWriter, r *http.Request, backupDir string) (string, string, bool) {
	name := chi.URLParam(r, "name")
	if name == "" || strings.Contains(name, "..") || strings.ContainsAny(name, `/\`) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
		return "", "", false
	}
	target := filepath.Join(backupDir, name)
	if !strings.HasPrefix(target, backupDir+string(filepath.Separator)) {
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "invalid backup name")
		return "", "", false
	}
	return name, target, true
}

func handleDeleteBackup(database *db.DB, paths backupPaths) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, target, ok := resolveBackupName(w, r, paths.dir)
		if !ok {
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

// verifyRestoreSource refuses a backup that must not replace the live
// database, writing the error response itself. It runs before the pre-restore
// safety copy and before anything is closed.
func verifyRestoreSource(w http.ResponseWriter, r *http.Request, name, target string) bool {
	// Refuse to overwrite the live database with a file SQLite itself
	// rejects — a truncated pre-crash backup, a stray non-database .db.
	// The pre-restore safety copy would make this survivable, but "restore
	// succeeded" followed by a broken server is still the worst UX here.
	if err := db.CheckBackupIntegrity(context.WithoutCancel(r.Context()), target); err != nil {
		slog.Error("restore refused: backup failed integrity check", "backup", name, "err", err)
		writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "backup file failed integrity verification")
		return false
	}

	// Refuse a backup a NEWER server wrote (REL-02): restoring it would put
	// this older binary on a schema it has never seen, and it would then
	// boot silently on it.
	ahead, err := db.CheckBackupSchemaAhead(context.WithoutCancel(r.Context()), target)
	if err != nil {
		slog.Error("restore refused: could not read backup schema version", "backup", name, "err", err)
		writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not verify the backup's schema version")
		return false
	}
	if len(ahead) > 0 {
		slog.Warn("restore refused: backup schema is newer than this server", "backup", name, "unknown_migrations", strings.Join(ahead, ","))
		writeErr(w, http.StatusConflict, "SCHEMA_TOO_NEW",
			"backup was written by a newer server version; upgrade this server before restoring it")
		return false
	}
	return true
}

// restoreCarryTimeout bounds the live seq floor read in a restore request.
const restoreCarryTimeout = 10 * time.Second

// handleRestoreBackup verifies a backup and stages it for the next boot. It
// never writes over the open database: the staged copy and a marker (written
// last) are applied by db.ApplyStagedRestore before the database opens again,
// and the restart goes through the normal shutdown path.
func handleRestoreBackup(database *db.DB, paths backupPaths) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name, target, ok := resolveBackupName(w, r, paths.dir)
		if !ok {
			return
		}

		// Serialize against a concurrent update apply (which stages a new
		// binary and then restarts) and an already-requested restart. The
		// deferred release is a busy→idle CAS, so it covers every failure
		// return below and harmlessly no-ops once a branch has promoted the
		// state to restart-pending via commitRestartPending.
		if !beginRestartSensitiveOp() {
			writeRestartConflict(w)
			return
		}
		defer abortRestartSensitiveOp()

		if _, err := os.Stat(target); os.IsNotExist(err) { //nolint:gosec // G703: path sanitized by HasPrefix check above
			writeErr(w, http.StatusNotFound, "NOT_FOUND", "backup not found")
			return
		}

		if !verifyRestoreSource(w, r, name, target) {
			return
		}

		dbPath := paths.dbFile
		ctx := context.WithoutCancel(r.Context())

		actor := actorFromContext(r)
		// Audit the restore BEFORE the pre-restore safety copy is taken, and
		// synchronously (LogAudit, not WriteAudit), so the row is durable in the
		// live database and in the safety copy. Best-effort per policy D8: a
		// failed write is logged, never a reason to refuse the restore.
		if err := database.LogAudit(ctx, actor, "backup_restore", "server", 0,
			fmt.Sprintf("restoring backup %s", name)); err != nil {
			slog.Error("audit log write failed", "action", "backup_restore", "actor_id", actor, "error", err)
		}

		// Safety: create a pre-restore backup first. WithoutCancel: the safety
		// copy must not be skippable by a canceled request ctx. paths.dir,
		// not a cwd-relative path, so it lands beside the rest of the backups.
		preRestore := filepath.Join(paths.dir, PreRestoreBackupPrefix+time.Now().UTC().Format("20060102_150405")+".db")
		if err := database.BackupToSafe(ctx, preRestore, paths.dir); err != nil {
			// Fail closed. The admin panel promises "a pre-restore backup will
			// be created"; proceeding without one takes away the safety net the
			// operator was shown, exactly when they need it.
			slog.Error("pre-restore backup failed — aborting restore", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR",
				"could not create the pre-restore safety backup — restore aborted, database untouched")
			return
		}
		// Nothing is restored on a refusal below, so the safety copy protects
		// nothing; it is kept from retention, so a retried refusal would
		// otherwise leave one database-sized file per attempt.
		dropSafetyCopy := func() {
			if err := os.Remove(preRestore); err != nil {
				slog.Warn("could not remove the unused pre-restore safety copy", "path", preRestore, "err", err)
			}
		}

		// Carry the live event sequence floor into the sidecar that outlives the
		// swap, so the next boot reserves its block above everything this server
		// handed out. The boot-time apply folds it in again from the closed
		// database. A floor that cannot be stored refuses the restore; any other
		// trouble (an unreadable live database) only warns.
		carryCtx, carryCancel := context.WithTimeout(ctx, restoreCarryTimeout)
		err := db.CarryWSSeqFloorForRestore(carryCtx, dbPath)
		carryCancel()
		if errors.Is(err, db.ErrWSSeqFloorNotStored) {
			slog.Error("restore refused: could not preserve the event sequence floor", "err", err)
			dropSafetyCopy()
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR",
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
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR",
				"could not stage the backup — database untouched")
			return
		}

		slog.Warn("restore staged — the next start applies it", "actor_id", actor, "backup", name)

		// The marker is committed. Trim old safety copies, protecting the new
		// one and the restore source (an operator undoing a bad restore
		// restores from a pre_restore_ copy). A prune failure is logged and
		// never changes the outcome. The staged copy is not in backup.dir, so
		// it can never be pruned.
		if removed, pruneErr := PruneSafetyCopies(paths.dir, SafetyCopiesKept, preRestore, target); pruneErr != nil {
			slog.Warn("could not prune old safety copies", "dir", paths.dir, "error", pruneErr)
		} else if len(removed) > 0 {
			slog.Info("pruned old safety copies", "count", len(removed), "names", removed)
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "restore staged — server restarting",
			"backup":  name,
		})

		// Restart through the normal shutdown path: the restart coordinator
		// tells clients (one server_restart notice), drains requests and closes
		// the database, and the next start swaps the staged copy in.
		commitRestartPending()
		go requestRestart("backup_restore")
	})
}
