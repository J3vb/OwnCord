package admin

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/owncord/server/db"
)

// backupBaseDir is the directory for backup files, resolved to an absolute
// path at package init time so handlers don't depend on the process CWD (L14).
var backupBaseDir string

func init() {
	abs, err := filepath.Abs(filepath.Join("data", "backups"))
	if err == nil {
		backupBaseDir = abs
	} else {
		backupBaseDir = filepath.Join("data", "backups")
	}
}

// SetBackupBaseDir overrides backupBaseDir. Intended for tests only.
func SetBackupBaseDir(dir string) { backupBaseDir = dir }

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

		if err := database.BackupTo(backupPath); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "backup failed")
			return
		}

		actor := actorFromContext(r)
		backupName := filepath.Base(backupPath)
		slog.Info("database backup created", "actor_id", actor, "name", backupName)
		_ = database.LogAudit(actor, "backup_create", "server", 0,
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
		_ = database.LogAudit(actor, "backup_delete", "server", 0, "deleted backup "+name)

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

		dbPath := filepath.Join("data", "chatserver.db")

		// Safety: create a pre-restore backup before overwriting.
		preRestore := filepath.Join("data", "backups", "pre_restore_"+time.Now().UTC().Format("20060102_150405")+".db")
		if err := database.BackupTo(preRestore); err != nil {
			slog.Warn("pre-restore backup failed", "err", err)
		}

		// Notify clients that the server is restarting.
		hub.BroadcastServerRestart("backup_restore", 5)

		// Checkpoint the WAL and close the database connection before overwriting
		// to prevent corruption from concurrent writes (BUG-096).
		if _, checkpointErr := database.SQLDb().Exec("PRAGMA wal_checkpoint(TRUNCATE)"); checkpointErr != nil {
			slog.Warn("pre-restore WAL checkpoint failed", "err", checkpointErr)
		}

		actor := actorFromContext(r)
		slog.Warn("database restored from backup — closing DB", "actor_id", actor, "backup", name)

		if err := database.Close(); err != nil {
			slog.Error("failed to close database before restore", "err", err)
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to close database")
			return
		}

		// Stream the backup file over the (now closed) database to avoid loading
		// the entire DB into memory (could be hundreds of MiB).
		if err := copyFile(target, dbPath); err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "failed to restore database file")
			return
		}

		slog.Warn("database file replaced — server must restart to use restored data", "backup", name)

		writeJSON(w, http.StatusOK, map[string]string{
			"message": "database restored — server restarting",
			"backup":  name,
		})
	})
}

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
