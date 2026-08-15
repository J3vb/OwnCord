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
	"golang.org/x/mod/semver"
)

// handleCheckUpdate returns the current update status. can_apply tells the
// admin SPA whether POST /updates/apply is usable in this deployment (false
// in containers, where upgrades are image pulls).
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
		writeJSON(w, http.StatusOK, struct {
			updater.UpdateInfo
			CanApply bool `json:"can_apply"`
		}{info, !updater.RunningInContainer()})
	}
}

// handleApplyUpdate downloads and applies a server update.
func handleApplyUpdate(u *updater.Updater, hub HubBroadcaster, _ string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In a container the running binary is image content: the staged
		// replacement dies with the container and the restart comes back as
		// the old image. Refuse before any nil/availability logic so the
		// answer does not depend on updater configuration.
		if updater.RunningInContainer() {
			writeErr(w, http.StatusServiceUnavailable, "CONTAINER_DEPLOYMENT",
				"in-place self-update is disabled in container deployments — upgrade by pulling the new image")
			return
		}
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
			if semver.Compare(info.Current, info.Latest) < 0 && !info.RequiredAssetsPresent {
				writeErr(w, http.StatusBadGateway, "MISSING_ASSETS", "release is missing required assets")
				return
			}
			writeErr(w, http.StatusConflict, "NO_UPDATE", "server is already up to date")
			return
		}
		if !info.RequiredAssetsPresent {
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

		// DownloadAndVerify stages the binary and returns its trusted hash
		// (bound to the signed release manifest). The apply goroutine below
		// re-verifies the staged file against this hash through an open
		// handle — never by path — before the rename+spawn.
		stagedHash, err := u.DownloadAndVerify(ctx, info.Latest, info.DownloadURL, info.ChecksumURL, info.SignatureURL, info.ManifestURL, info.ManifestSignatureURL, newPath)
		if err != nil {
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
			if applyStagedUpdate(hub, exePath, oldPath, newPath, stagedHash) {
				// Every deferred cleanup inside applyStagedUpdate has run by
				// now, which is why the exit lives out here.
				os.Exit(0) // fallback if the SIGTERM handler didn't exit
			}
		}()
	})
}

// applyStagedUpdate performs the on-disk swap (verified staged binary ->
// exePath) and spawns the replacement process. The caller has already
// broadcast "restarting in 5s" to every connected client before invoking
// this, so every return path that does NOT end in a successful respawn must
// correct that promise — otherwise the client's restart banner counts down
// to a permanent "Reconnecting..." over a connection that never actually
// dropped (OC-0226). The deferred broadcast below covers all such paths
// (verification failure, rename failure, commit failure, spawn failure) with
// one guard instead of one broadcast per failure branch; it is cancelled by
// setting restarting=true immediately before the process commits to
// respawning.
// It reports whether the process is committed to exiting for the replacement.
// The exit itself belongs to the caller: calling os.Exit here would skip both
// deferred cleanups below (the staged-file handle and the corrective
// broadcast), and on Windows releasing that handle is the very thing the
// restart is for.
func applyStagedUpdate(hub HubBroadcaster, exePath, oldPath, newPath, stagedHash string) bool {
	restarting := false
	defer func() {
		if !restarting && hub != nil {
			hub.BroadcastServerRestart("update_aborted", 0)
		}
	}()

	// TOCTOU guard: open the staged binary once, verify its hash
	// through that handle, and commit (rename) that exact file.
	// Commit fails if the path was swapped after verification, so
	// the bytes verified are the bytes spawned.
	staged, err := updater.OpenVerifiedBinary(newPath, stagedHash)
	if err != nil {
		slog.Error("update: staged binary re-verification failed, aborting update", "error", err)
		return false
	}
	defer staged.Close() //nolint:errcheck

	// Rename: current -> .old, verified staged binary -> current
	_ = os.Remove(oldPath) // remove any stale .old
	if err := os.Rename(exePath, oldPath); err != nil {
		slog.Error("update: rename current to old failed", "error", err)
		return false
	}
	if err := staged.Commit(exePath); err != nil {
		slog.Error("update: committing staged binary failed, restoring original binary", "error", err)
		// Whatever is at exePath now (if anything) is not the verified
		// binary; restoring .old replaces it.
		if restoreErr := os.Rename(oldPath, exePath); restoreErr != nil {
			slog.Error("update: CRITICAL — recovery rename also failed, server binary may be missing",
				"restore_error", restoreErr, "original_error", err,
				"old_path", oldPath, "exe_path", exePath)
		}
		return false
	}

	// Spawn new process.
	if err := updater.SpawnDetached(exePath, os.Args[1:]); err != nil {
		slog.Error("update: spawn new process failed", "error", err)
		return false
	}

	// The replacement process is spawned: from here on this process is
	// committed to shutting down for it, so the "restarting" promise made at
	// the top of handleApplyUpdate's goroutine is about to come true. Cancel
	// the deferred corrective broadcast.
	restarting = true

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
	return true
}
