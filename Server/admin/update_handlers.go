package admin

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", "failed to check for updates: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, info)
	}
}

// handleApplyUpdate downloads and applies a server update.
func handleApplyUpdate(u *updater.Updater, hub HubBroadcaster, _ string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, "UPDATE_UNAVAILABLE", "update checking is not configured")
			return
		}

		// Check for available update.
		info, err := u.CheckForUpdate(r.Context())
		if err != nil {
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", err.Error())
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
			writeErr(w, http.StatusBadGateway, "DOWNLOAD_FAILED", err.Error())
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
				// Try to restore
				_ = os.Rename(oldPath, exePath)
				return
			}

			// Spawn new process.
			if err := spawnDetached(exePath, os.Args[1:]); err != nil {
				slog.Error("update: spawn new process failed", "error", err)
				return
			}

			// Exit current process.
			slog.Info("update: new process spawned, exiting current process")
			os.Exit(0)
		}()
	})
}

// spawnDetached starts a new process that is not attached to the current one.
func spawnDetached(exePath string, args []string) error {
	cmd := exec.Command(exePath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = &syscall.SysProcAttr{
			CreationFlags: 0x00000008, // DETACHED_PROCESS
		}
	}

	return cmd.Start()
}
