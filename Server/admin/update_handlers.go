package admin

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
	"golang.org/x/mod/semver"
)

// installWritable reports whether the install directory accepts the files a
// self-update writes next to the binary. A var so tests can stand in for a
// read-only install without depending on file permissions.
var installWritable = func() error {
	exePath, err := updater.ExecutablePath()
	if err != nil {
		return fmt.Errorf("resolving executable path: %w", err)
	}
	return updater.CanReplaceExecutable(exePath)
}

// Values of apply_blocked in the update check response.
const (
	applyBlockedContainer       = "container"
	applyBlockedInstallReadOnly = "install_read_only"
)

// handleCheckUpdate returns the current update status. can_apply tells the
// admin SPA whether POST /updates/apply is usable in this deployment: false in
// containers (upgrades are image pulls) and when the service cannot write to
// its install directory. apply_blocked names which; the container check wins.
func handleCheckUpdate(u *updater.Updater) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeUpdateUnavailable, "update checking is not configured")
			return
		}
		info, err := u.CheckForUpdate(r.Context())
		if err != nil {
			slog.Error("update check failed", "err", err)
			writeErr(w, http.StatusBadGateway, httperr.CodeUpdateCheckFailed, "failed to check for updates — see server logs")
			return
		}
		blocked := ""
		switch {
		case updater.RunningInContainer():
			blocked = applyBlockedContainer
		case installWritable() != nil:
			blocked = applyBlockedInstallReadOnly
		}
		writeJSON(w, http.StatusOK, struct {
			updater.UpdateInfo
			CanApply     bool   `json:"can_apply"`
			ApplyBlocked string `json:"apply_blocked,omitempty"`
		}{info, blocked == "", blocked})
	}
}

// applyRestartDelay is how long the "restarting in 5s" countdown broadcast to
// clients actually gets before the swap + restart request. A var so tests can
// shrink it; the broadcast countdown below stays 5 to match this value.
var applyRestartDelay = 5 * time.Second

// downloadAndVerify is the updater's download stage; a var only so a test can
// stand in for it (the real one needs a signed release manifest).
var downloadAndVerify = (*updater.Updater).DownloadAndVerify

// applyCancelled answers 503 SERVER_SHUTTING_DOWN and reports true when the
// apply's context was cancelled (shutdown, via EndApplies) rather than timed
// out. A deadline stays on the ordinary failure codes.
func applyCancelled(ctx context.Context, w http.ResponseWriter) bool {
	if !errors.Is(ctx.Err(), context.Canceled) {
		return false
	}
	slog.Info("update apply cancelled: the server is shutting down", "cause", ctx.Err())
	writeErr(w, http.StatusServiceUnavailable, httperr.CodeServerShuttingDown,
		"The server is shutting down; try the update again once it is back")
	return true
}

// applyBudget bounds one POST /updates/apply: the release check, the asset
// download and its verification, together. It matches the transfer lifetime in
// api (transferMaxLifetime). The request context ends at this budget, and the
// connection deadlines are set from that context's deadline plus
// applyDeadlineMargin (see extendApplyDeadlines).
const applyBudget = 10 * time.Minute

// applyDeadlineMargin is added to applyBudget for the connection deadlines so
// the handler's own context expires first and its error response can still be
// written.
const applyDeadlineMargin = 30 * time.Second

// extendApplyDeadlines pushes the connection's read and write deadlines out to
// cover applyBudget. The server's WriteTimeout is far shorter than a slow
// download; without this the stream is reset (HTTP/2) or the late response is
// never delivered (HTTP/1.1) while the update carries on. The read deadline
// moves too because on HTTP/1.1 an expired read deadline cancels the request
// context. Errors are ignored: http.ErrNotSupported means the writer has no
// connection (a test recorder), so there is no deadline to extend. The
// ResponseController reaches the connection through any wrapper that exposes
// Unwrap.
func extendApplyDeadlines(w http.ResponseWriter, deadline time.Time) {
	ctl := http.NewResponseController(w)
	_ = ctl.SetReadDeadline(deadline)
	_ = ctl.SetWriteDeadline(deadline)
}

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
func handleApplyUpdate(database *db.DB, u *updater.Updater, hub HubBroadcaster, _ string, bg *syncutil.Group, shutdown <-chan struct{}) http.Handler {
	stop := stopSignal{draining: bg.Draining(), shutdown: shutdown}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In a container the running binary is image content: the staged
		// replacement dies with the container and the restart comes back as
		// the old image. Refuse before any nil/availability logic so the
		// answer does not depend on updater configuration.
		if updater.RunningInContainer() {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeContainerDeployment,
				"in-place self-update is disabled in container deployments — upgrade by pulling the new image")
			return
		}
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeUpdateUnavailable, "update checking is not configured")
			return
		}

		// A shutdown that has already begun refuses the request up front:
		// before any outbound call, any slot claim and any long download,
		// while the database is surely open.
		if stop.stopping() {
			refuseApplyShuttingDown(w)
			return
		}

		// A read-only install directory cannot take the staged file or the
		// backup name, so say so before any download or countdown rather than
		// failing later as a download error.
		if err := installWritable(); err != nil {
			slog.Info("update apply refused: install directory not writable", "err", err)
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeInstallReadOnly,
				"this server cannot replace its own program file (the install folder is read-only to the service) — install the new release by hand")
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

		// One budget for the check and the download. EndApplies cancels it at
		// shutdown. The connection deadlines are derived from it, so the final
		// response can always still be written after the context expires.
		ctx, cancel := context.WithTimeout(r.Context(), applyBudget)
		defer cancel()
		srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
		defer trackApply(srv, cancel)()
		if dl, ok := ctx.Deadline(); ok {
			extendApplyDeadlines(w, dl.Add(applyDeadlineMargin))
		}

		// Check for available update.
		info, ok := checkApplyUpdate(ctx, w, u)
		if !ok {
			return
		}

		// Use the installation path captured before any update can rename
		// the running image; restart handoff and cleanup use this same path.
		exePath, err := updater.ExecutablePath()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "cannot determine executable path")
			return
		}
		newPath := exePath + ".new"

		// Download and verify.

		// DownloadAndVerify stages the binary and returns its trusted hash
		// (bound to the signed release manifest). The apply goroutine below
		// re-verifies the staged file against this hash through an open
		// handle — never by path — before the rename.
		stagedHash, ok := stageApplyUpdate(ctx, w, u, &info, newPath)
		if !ok {
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

		// The tail runs on the app's background group, so shutdown can abort
		// its countdown and join it before the database closes. Admitted
		// before the response, so a refusal (the process is already shutting
		// down) can still be answered honestly: the slot is released by the
		// deferred abort and the outcome row records that nothing was swapped.
		// The goroutine takes over the busy state claimed above, so the
		// deferred release stands down once the job is admitted.
		// Checked again after the download: a handler that finishes during
		// the drain must not tell the admin UI the server is restarting.
		if stop.stopping() || !bg.Go(auditCtx, func(jobCtx context.Context) {
			applyAndRestart(jobCtx, database, actor, info.Latest, hub, exePath, newPath, stagedHash, stop)
		}) {
			auditUpdateOutcome(auditCtx, database, actor, "update_failed",
				fmt.Sprintf("staged server update %s was not applied, the server is shutting down", info.Latest))
			refuseApplyShuttingDown(w)
			return
		}
		claimed = false
		// Shutdown can begin while the job is being admitted. The job then
		// aborts its countdown, releases the slot and records update_failed
		// itself, so the handler only has to stop claiming success.
		if stop.stopping() {
			refuseApplyShuttingDown(w)
			return
		}

		// Respond to the client; the countdown broadcast and the swap
		// continue in the background.
		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "applying",
			"version": info.Latest,
		})
	})
}

// checkApplyUpdate runs the release check for an apply. It reports false after
// writing the refusal (cancelled, check failed, missing assets, or no update).
func checkApplyUpdate(ctx context.Context, w http.ResponseWriter, u *updater.Updater) (updater.UpdateInfo, bool) {
	info, err := u.CheckForUpdate(ctx)
	if err == nil && ctx.Err() != nil {
		err = ctx.Err() // the check does not stop on cancel; the apply must
	}
	if err != nil {
		if applyCancelled(ctx, w) {
			return updater.UpdateInfo{}, false
		}
		slog.Error("update check failed during apply", "err", err)
		writeErr(w, http.StatusBadGateway, httperr.CodeUpdateCheckFailed, "failed to check for updates — see server logs")
		return updater.UpdateInfo{}, false
	}
	if !info.UpdateAvailable {
		if semver.Compare(info.Current, info.Latest) < 0 && !info.RequiredAssetsPresent {
			writeErr(w, http.StatusBadGateway, httperr.CodeMissingAssets, "release is missing required assets")
			return updater.UpdateInfo{}, false
		}
		writeErr(w, http.StatusConflict, httperr.CodeNoUpdate, "server is already up to date")
		return updater.UpdateInfo{}, false
	}
	if !info.RequiredAssetsPresent {
		writeErr(w, http.StatusBadGateway, httperr.CodeMissingAssets, "release is missing required assets")
		return updater.UpdateInfo{}, false
	}
	return info, true
}

// stageApplyUpdate downloads and verifies the release into newPath and returns
// its trusted hash (bound to the signed release manifest). It reports false
// after writing the refusal, having removed the staged file.
func stageApplyUpdate(ctx context.Context, w http.ResponseWriter, u *updater.Updater, info *updater.UpdateInfo, newPath string) (string, bool) {
	stagedHash, err := downloadAndVerify(u, ctx, info.Latest, info.DownloadURL, info.ChecksumURL, info.SignatureURL, info.ManifestURL, info.ManifestSignatureURL, newPath)
	if err == nil && ctx.Err() != nil {
		// Cancelled (shutdown) after verification but before the swap was
		// promised: do not start it, and do not leave the staged file.
		err = ctx.Err()
	}
	if err != nil {
		_ = os.Remove(newPath)
		if applyCancelled(ctx, w) {
			return "", false
		}
		slog.Error("update download/verify failed", "err", err)
		writeErr(w, http.StatusBadGateway, httperr.CodeDownloadFailed, "download or verification failed — see server logs")
		return "", false
	}
	return stagedHash, true
}

// applyAndRestart is POST /updates/apply's background tail: give clients the
// promised countdown, swap the binary on disk, and hand the process over to
// the main package's restart coordinator. On a failed swap it releases the
// exclusive slot claimed by the handler so a corrected release can be applied
// without a manual restart (the corrective update_aborted broadcast is sent
// by applyStagedUpdate's deferred guard).
//
// stop fires when the process starts shutting down. It, not ctx, ends the
// countdown early: ctx is cancelled only after the group's grace, so a
// SIGTERM during the countdown would otherwise still swap the binary and ask
// for a restart the operator did not want. On a drain nothing is swapped, the
// slot is released and an update_failed row is written while the database is
// still open (the background-jobs step runs before it closes).
func applyAndRestart(ctx context.Context, database *db.DB, actor int64, version string, hub HubBroadcaster, exePath, newPath, stagedHash string, stop stopSignal) {
	if hub != nil {
		hub.BroadcastServerRestart(ws.RestartReasonUpdate, 5)
	}
	if !stop.waitCountdown() {
		auditUpdateOutcome(ctx, database, actor, "update_failed",
			fmt.Sprintf("staged server update %s was not applied, the server began shutting down during the countdown and the running binary is unchanged", version))
		abortRestartSensitiveOp()
		return
	}
	if applyStagedUpdate(hub, exePath, newPath, stagedHash, stop.stopping) {
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

// stopSignal says the process has begun to shut down. Two channels carry it
// because they close at different times: shutdown closes at the very start of
// App.Close (before the HTTP drain), draining only when the background group
// is stopped, seven steps later. The group's ctx is cancelled later still, so
// it is never the signal. Either channel may be nil, which never fires.
type stopSignal struct {
	draining <-chan struct{}
	shutdown <-chan struct{}
}

// stopping reports, without blocking, whether a shutdown has begun.
func (s stopSignal) stopping() bool {
	select {
	case <-s.shutdown:
		return true
	case <-s.draining:
		return true
	default:
		return false
	}
}

// waitCountdown sleeps the restart countdown and reports whether it ran to
// the end. It returns false as soon as either signal fires, and also when a
// shutdown began in the instant the timer fired, so a shutdown that has
// started never goes on to swap the binary.
func (s stopSignal) waitCountdown() bool {
	timer := time.NewTimer(applyRestartDelay)
	defer timer.Stop()
	select {
	case <-s.shutdown:
		return false
	case <-s.draining:
		return false
	case <-timer.C:
	}
	return !s.stopping()
}

// refuseApplyShuttingDown answers a request the shutdown arrived before.
func refuseApplyShuttingDown(w http.ResponseWriter) {
	writeErr(w, http.StatusServiceUnavailable, httperr.CodeShuttingDown, "the server is shutting down — the update was not applied")
}

// updateOutcomeTimeout bounds the synchronous outcome row. The row must be
// written even when the group cancelled the job's ctx at the end of its grace.
const updateOutcomeTimeout = 5 * time.Second

// auditUpdateOutcome writes the outcome row synchronously. database is nil in
// tests that exercise the swap without a store.
func auditUpdateOutcome(ctx context.Context, database *db.DB, actor int64, action, detail string) {
	if database == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), updateOutcomeTimeout)
	defer cancel()
	if err := database.LogAudit(ctx, actor, action, "server", 0, detail); err != nil {
		slog.Error("update: writing the outcome audit row failed", "action", action, "error", err)
	}
}

// applyStagedUpdate performs the on-disk swap: verified staged binary ->
// exePath, previous binary -> a unique exePath.old-*. It reports whether the
// swap committed — on true the caller must request a restart, because the
// file at exePath is no longer the binary this process is running.
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
// package's job, after run() has fully drained (Server/internal/app/restart.go).
// Keeping
// the swap free of process side effects is also what makes the success path
// unit-testable.
//
// The name is unique because an earlier binary can still be running: on
// Windows a server on a console stays behind until its replacement exits
// (updater.SpawnReplacement), and its image cannot be replaced or removed
// until then.
func applyStagedUpdate(hub HubBroadcaster, exePath, newPath, stagedHash string, stopping func() bool) bool {
	committed := false
	defer func() {
		if !committed && hub != nil {
			hub.BroadcastServerRestart(ws.RestartReasonUpdateAborted, 0)
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

	// Last chance to honour a shutdown that landed in the moments since the
	// countdown ended: nothing has been renamed yet. A nil stopping never
	// fires.
	if stopping != nil && stopping() {
		slog.Info("update: shutdown began before the swap, leaving the running binary in place")
		return false
	}

	// Rename: current -> .old-*, verified staged binary -> current
	reserved, err := os.CreateTemp(filepath.Dir(exePath), filepath.Base(exePath)+".old-*")
	if err != nil {
		slog.Error("update: reserving a name for the previous binary failed", "error", err)
		return false
	}
	oldPath := reserved.Name()
	_ = reserved.Close()
	if err := os.Rename(exePath, oldPath); err != nil {
		_ = os.Remove(oldPath)
		slog.Error("update: rename current to old failed", "error", err)
		return false
	}
	if err := staged.Commit(exePath); err != nil {
		slog.Error("update: committing staged binary failed, restoring original binary", "error", err)
		// Whatever is at exePath now (if anything) is not the verified
		// binary; restoring the previous one replaces it.
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
