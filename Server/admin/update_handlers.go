package admin

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/owncord/server/updater"
)

// handleCheckUpdate returns the current update status.
func handleCheckUpdate(u *updater.Updater) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, "UPDATE_UNAVAILABLE", "update checking is not configured")
			return
		}
		info, err := u.CheckForUpdate(r.Context())
		if err != nil {
			slog.Error("update check failed", "err", err)
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", "failed to check for updates — see server logs")
			return
		}
		writeJSON(w, http.StatusOK, info)
	}
}

// handleApplyUpdate downloads and applies a server update.
func handleApplyUpdate(u *updater.Updater, hub HubBroadcaster, _ string) http.Handler {
	//TODO: maybe disable this endpoint in future docker build type?
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, "UPDATE_UNAVAILABLE", "update checking is not configured")
			return
		}

		// Check for available update.
		info, err := u.CheckForUpdate(r.Context())
		if err != nil {
			slog.Error("update check failed during apply", "err", err)
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", "failed to check for updates — see server logs")
			return
		}
		if !info.UpdateAvailable {
			writeErr(w, http.StatusConflict, "NO_UPDATE", "server is already up to date")
			return
		}
		if info.DownloadURL == "" || info.ChecksumURL == "" {
			writeErr(w, http.StatusBadGateway, "MISSING_ASSETS", "release is missing required assets")
			return
		}

		// Get current executable path.
		exePath, err := os.Executable()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "cannot determine executable path")
			return
		}
		exePath, err = filepath.EvalSymlinks(exePath)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "INTERNAL_ERROR", "cannot resolve executable path")
			return
		}

		newPath := exePath + ".new"
		oldPath := exePath + ".old"

		// Download and verify.
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
		defer cancel()

		if err := u.DownloadAndVerify(ctx, info.DownloadURL, info.ChecksumURL, newPath); err != nil {
			slog.Error("update download/verify failed", "err", err)
			writeErr(w, http.StatusBadGateway, "DOWNLOAD_FAILED", "download or verification failed — see server logs")
			return
		}

		// Respond to the client before shutting down.
		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "applying",
			"version": info.Latest,
		})

		// Broadcast restart notification and apply in background.
		go func() {
			if hub != nil {
				hub.BroadcastServerRestart("update", 5)
			}
			time.Sleep(5 * time.Second)

			// Rename: current -> .old, .new -> current
			_ = os.Remove(oldPath) // remove any stale .old
			if err := os.Rename(exePath, oldPath); err != nil {
				slog.Error("update: rename current to old failed", "error", err)
				return
			}
			if err := os.Rename(newPath, exePath); err != nil {
				slog.Error("update: rename new to current failed", "error", err)
				// Try to restore the original binary.
				if restoreErr := os.Rename(oldPath, exePath); restoreErr != nil {
					slog.Error("update: CRITICAL — recovery rename also failed, server binary may be missing",
						"restore_error", restoreErr, "original_error", err,
						"old_path", oldPath, "exe_path", exePath)
					if hub != nil {
						hub.BroadcastServerRestart("update_failed", 0)
					}
				}
				return
			}

			// Spawn new process.
			if err := updater.SpawnDetached(exePath, os.Args[1:]); err != nil {
				slog.Error("update: spawn new process failed", "error", err)
				return
			}

			// Signal the process to shut down gracefully before exiting.
			// We use SIGTERM on Unix to trigger the graceful shutdown handler
			// in main.go. On Windows, os.Exit is unavoidable because the
			// process must release its file lock on the binary.
			slog.Info("update: new process spawned, shutting down current process")
			if p, err := os.FindProcess(os.Getpid()); err == nil {
				_ = p.Signal(syscall.SIGTERM)
				// Give graceful shutdown a few seconds before force-killing.
				time.Sleep(10 * time.Second)
			}
			os.Exit(0) // fallback if SIGTERM handler didn't exit
		}()
	})
}
