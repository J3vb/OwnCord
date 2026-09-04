package admin

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/updater"
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

// applyRestartDelay is how long the "restarting in 5s" countdown broadcast to
// clients actually gets before the swap + restart request. A var so tests can
// shrink it; the broadcast countdown below stays 5 to match this value.
var applyRestartDelay = 5 * time.Second

// handleApplyUpdate downloads and applies a server update.
//
// It is audited, which is why it takes a database handle it otherwise has no
// use for. Replacing the running binary is the largest change an owner
// credential can make — strictly larger than plugin_install, which B2-6 chose
// to audit — and until OC-0391 it was the one owner-only mutation on this
// router that wrote no audit row at all, on any path. Both halves are
// recorded: update_apply when the verified binary is staged and the swap
// becomes inevitable, update_applied or update_failed for what actually
// happened.
func handleApplyUpdate(database *db.DB, u *updater.Updater, hub HubBroadcaster, _ string) http.Handler {
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

		// Serialize against concurrent applies, restores, and an
		// already-requested restart — claimed before any updater work so a
		// pending restart answers 409 without an outbound GitHub call, and
		// so two concurrent applies can never both stage into the same .new
		// path (each download removes the other's staged file). The deferred
		// release covers every early return; ownership transfers to the
		// applyAndRestart goroutine at the bottom.
		if !beginRestartSensitiveOp() {
			writeRestartConflict(w)
			return
		}
		claimed := true
		defer func() {
			if claimed {
				abortRestartSensitiveOp()
			}
		}()

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
		// handle — never by path — before the rename.
		stagedHash, err := u.DownloadAndVerify(ctx, info.Latest, info.DownloadURL, info.ChecksumURL, info.SignatureURL, info.ManifestURL, info.ManifestSignatureURL, newPath)
		if err != nil {
			slog.Error("update download/verify failed", "err", err)
			writeErr(w, http.StatusBadGateway, "DOWNLOAD_FAILED", "download or verification failed — see server logs")
			return
		}

		// Audited here rather than on entry: everything above can refuse the
		// request, and a row per refused attempt would bury the one that
		// matters. From this point the binary is staged and verified and the
		// swap happens in the background, so this is the last moment the
		// request context is still alive to carry it.
		actor := actorFromContext(r)
		auditCtx := context.WithoutCancel(r.Context())
		slog.Info("server update applying", "actor_id", actor, "from", info.Current, "to", info.Latest)
		db.WriteAudit(auditCtx, database, actor, "update_apply", "server", 0,
			fmt.Sprintf("applying server update %s -> %s", info.Current, info.Latest))

		// Respond to the client before shutting down.
		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "applying",
			"version": info.Latest,
		})

		// Broadcast the restart countdown and finish in the background — the
		// goroutine takes over the busy state claimed above, so the deferred
		// release must stand down.
		claimed = false
		go applyAndRestart(auditCtx, database, actor, info.Latest, hub, exePath, oldPath, newPath, stagedHash)
	})
}

// applyAndRestart is POST /updates/apply's background tail: give clients the
// promised countdown, swap the binary on disk, and hand the process over to
// the main package's restart coordinator. On a failed swap it releases the
// exclusive slot claimed by the handler so a corrected release can be applied
// without a manual restart (the corrective update_aborted broadcast is sent
// by applyStagedUpdate's deferred guard).
func applyAndRestart(ctx context.Context, database *db.DB, actor int64, version string, hub HubBroadcaster, exePath, oldPath, newPath, stagedHash string) {
	if hub != nil {
		hub.BroadcastServerRestart("update", 5)
	}
	time.Sleep(applyRestartDelay)
	if applyStagedUpdate(hub, exePath, oldPath, newPath, stagedHash) {
		// Synchronous, like the backup restore's row and for the same reason:
		// the next thing this process does is hand itself over to the restart
		// coordinator, and a row still sitting in the async writer's buffer
		// would go with it. A failed write is logged, never a reason to leave
		// a swapped binary unstarted.
		auditUpdateOutcome(ctx, database, actor, "update_applied",
			fmt.Sprintf("server binary replaced with %s, restarting", version))
		commitRestartPending()
		requestRestart("update")
		return
	}
	auditUpdateOutcome(ctx, database, actor, "update_failed",
		fmt.Sprintf("staged server update %s was not applied, the running binary is unchanged", version))
	abortRestartSensitiveOp()
}

// auditUpdateOutcome writes the outcome row synchronously. database is nil in
// tests that exercise the swap without a store.
func auditUpdateOutcome(ctx context.Context, database *db.DB, actor int64, action, detail string) {
	if database == nil {
		return
	}
	if err := database.LogAudit(ctx, actor, action, "server", 0, detail); err != nil {
		slog.Error("update: writing the outcome audit row failed", "action", action, "error", err)
	}
}

// applyStagedUpdate performs the on-disk swap: verified staged binary ->
// exePath, previous binary -> .old. It reports whether the swap committed —
// on true the caller must request a restart, because the file at exePath is
// no longer the binary this process is running.
//
// The caller has already broadcast "restarting in 5s" to every connected
// client before invoking this, so every failure path must correct that
// promise — otherwise the client's restart banner counts down to a permanent
// "Reconnecting..." over a connection that never actually dropped (OC-0226).
// The deferred broadcast below covers all such paths (verification failure,
// rename failure, commit failure) with one guard; it is cancelled by setting
// committed=true once the verified binary is in place.
//
// It does NOT spawn, signal, or exit: the restart itself is the main
// package's job, after run() has fully drained (Server/restart.go). Keeping
// the swap free of process side effects is also what makes the success path
// unit-testable.
func applyStagedUpdate(hub HubBroadcaster, exePath, oldPath, newPath, stagedHash string) bool {
	committed := false
	defer func() {
		if !committed && hub != nil {
			hub.BroadcastServerRestart("update_aborted", 0)
		}
	}()

	// TOCTOU guard: open the staged binary once, verify its hash
	// through that handle, and commit (rename) that exact file.
	// Commit fails if the path was swapped after verification, so
	// the bytes verified are the bytes the restart will execute.
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

	committed = true
	slog.Info("update: staged binary committed — requesting restart", "path", exePath)
	return true
}
