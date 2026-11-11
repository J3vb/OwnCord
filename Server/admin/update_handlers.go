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

// installWritable reports whether the install directory accepts a self-update's files; a var so tests can
// fake a read-only install.
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
	applyBlockedDevelopment     = "development_build"
)

// handleCheckUpdate returns the update status. can_apply is false in containers (upgrades are image pulls),
// for a development build and when the install directory is unwritable; apply_blocked names which (container
// first).
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
		case u.DevelopmentBuild():
			blocked = applyBlockedDevelopment
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

// applyRestartDelay is how long the 5s restart countdown broadcast gets before the swap; a var so tests
// shrink it.
var applyRestartDelay = 5 * time.Second

// downloadAndVerify is a var only so a test can stand in for it (the real one needs a signed release
// manifest).
var downloadAndVerify = (*updater.Updater).DownloadAndVerify

// applyCancelled answers 503 SERVER_SHUTTING_DOWN and reports true when shutdown (EndApplies) cancelled the
// apply's context; a deadline stays on the ordinary failure codes.
func applyCancelled(ctx context.Context, w http.ResponseWriter) bool {
	if !errors.Is(ctx.Err(), context.Canceled) {
		return false
	}
	slog.Info("update apply cancelled: the server is shutting down", "cause", ctx.Err())
	writeErr(w, http.StatusServiceUnavailable, httperr.CodeServerShuttingDown,
		"The server is shutting down; try the update again once it is back")
	return true
}

// applyBudget bounds one POST /updates/apply (check, download, verification) and matches api's
// transferMinLifetime. The request context ends at it; connection deadlines extend to it plus
// applyDeadlineMargin.
const applyBudget = 10 * time.Minute

// applyDeadlineMargin extends the connection deadlines past applyBudget so the handler's own context expires
// first and its error response can still be written.
const applyDeadlineMargin = 30 * time.Second

// extendApplyDeadlines pushes the connection's deadlines out to cover applyBudget: the server's WriteTimeout
// is shorter than a slow download, so without this the stream is reset (HTTP/2) or the response never
// delivered (HTTP/1.1) while the update carries on. The read deadline moves too: on HTTP/1.1 an expired one
// cancels the request context. Errors are ignored: http.ErrNotSupported means no connection (a test
// recorder).
func extendApplyDeadlines(w http.ResponseWriter, deadline time.Time) {
	ctl := http.NewResponseController(w)
	_ = ctl.SetReadDeadline(deadline)
	_ = ctl.SetWriteDeadline(deadline)
}

// handleApplyUpdate downloads and applies a server update. It is audited, which is why it takes a database
// handle: replacing the running binary is the largest change an owner credential can make. update_apply is
// recorded once the swap becomes inevitable, update_applied or update_failed for the outcome.
func handleApplyUpdate(database *db.DB, u *updater.Updater, hub HubBroadcaster, _ string, bg *syncutil.Group, shutdown <-chan struct{}) http.Handler {
	stop := stopSignal{draining: bg.Draining(), shutdown: shutdown}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// In a container the running binary is image content: the staged replacement dies with it and the restart
		// comes back as the old image. Refuse before any availability logic so the answer ignores updater config.
		if updater.RunningInContainer() {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeContainerDeployment,
				"in-place self-update is disabled in container deployments — upgrade by pulling the new image")
			return
		}
		if u == nil {
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeUpdateUnavailable, "update checking is not configured")
			return
		}

		// Refuse a begun shutdown up front, before any outbound call, slot claim or download.
		if stop.stopping() {
			refuseApplyShuttingDown(w)
			return
		}

		// A source build would be replaced by the release binary, which is almost never what a source user wants.
		if u.DevelopmentBuild() {
			writeErr(w, http.StatusConflict, httperr.CodeDevelopmentBuild,
				"this is a development build; updates are not applied automatically, build or install the release by hand")
			return
		}

		// A read-only install directory cannot take the staged file or backup name; say so before any download.
		if err := installWritable(); err != nil {
			slog.Info("update apply refused: install directory not writable", "err", err)
			writeErr(w, http.StatusServiceUnavailable, httperr.CodeInstallReadOnly,
				"this server cannot replace its own program file (the install folder is read-only to the service) — install the new release by hand")
			return
		}

		// Serialize against concurrent applies, restores and a requested restart. Claimed before any updater work
		// so a pending restart answers 409 without an outbound call and two applies never stage into the same .new
		// path. Ownership transfers to the applyAndRestart goroutine at the bottom.
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

		// One budget for check and download; EndApplies cancels it at shutdown. Connection deadlines derive from
		// it.
		ctx, cancel := context.WithTimeout(r.Context(), applyBudget)
		defer cancel()
		srv, _ := r.Context().Value(http.ServerContextKey).(*http.Server)
		defer trackApply(srv, cancel)()
		if dl, ok := ctx.Deadline(); ok {
			extendApplyDeadlines(w, dl.Add(applyDeadlineMargin))
		}

		info, ok := checkApplyUpdate(ctx, w, u)
		if !ok {
			return
		}

		// Use the install path captured before an update can rename the running image.
		exePath, err := updater.ExecutablePath()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "cannot determine executable path")
			return
		}
		newPath := exePath + ".new"

		// DownloadAndVerify returns the trusted hash (bound to the signed manifest); the apply goroutine
		// re-verifies the staged file against it through an open handle, never by path, before the rename.
		stagedHash, ok := stageApplyUpdate(ctx, w, u, &info, newPath)
		if !ok {
			return
		}

		// Audited here, not on entry: earlier refusals would bury the one row that matters. From here the swap
		// happens in the background, so this is the last moment the request context is alive.
		actor := actorFromContext(r)
		auditCtx := context.WithoutCancel(r.Context())
		slog.Info("server update applying", "actor_id", actor, "from", info.Current, "to", info.Latest)
		db.WriteAudit(auditCtx, database, actor, "update_apply", "server", 0,
			fmt.Sprintf("applying server update %s -> %s", info.Current, info.Latest))

		// The tail runs on the app's background group so shutdown can abort its countdown and join it before the
		// database closes. Admitted before the response so a refusal can still be answered honestly; the goroutine
		// takes over the busy state claimed above. Checked again after the download: a handler finishing during the
		// drain must not tell the admin UI the server is restarting.
		if stop.stopping() || !bg.Go(auditCtx, func(jobCtx context.Context) {
			applyAndRestart(jobCtx, database, actor, info.Latest, hub, exePath, newPath, stagedHash, stop)
		}) {
			auditUpdateOutcome(auditCtx, database, actor, "update_failed",
				fmt.Sprintf("staged server update %s was not applied, the server is shutting down", info.Latest))
			refuseApplyShuttingDown(w)
			return
		}
		claimed = false
		// Shutdown can begin while the job is admitted; the job aborts, releases the slot and records update_failed
		// itself, so the handler only stops claiming success.
		if stop.stopping() {
			refuseApplyShuttingDown(w)
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"status":  "applying",
			"version": info.Latest,
		})
	})
}

// checkApplyUpdate runs the release check; it reports false after writing the refusal.
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

// stageApplyUpdate downloads and verifies the release into newPath and returns its trusted hash. It reports
// false after writing the refusal, having removed the staged file.
func stageApplyUpdate(ctx context.Context, w http.ResponseWriter, u *updater.Updater, info *updater.UpdateInfo, newPath string) (string, bool) {
	stagedHash, err := downloadAndVerify(u, ctx, info.Latest, info.DownloadURL, info.ChecksumURL, info.SignatureURL, info.ManifestURL, info.ManifestSignatureURL, newPath)
	if err == nil && ctx.Err() != nil {
		// Cancelled by shutdown after verification: do not start the swap or leave the staged file.
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

// applyAndRestart is POST /updates/apply's background tail: the promised countdown, the on-disk swap, then
// handoff to the main package's restart coordinator. A failed swap releases the exclusive slot so a corrected
// release can be applied without a restart. stop, not ctx, ends the countdown early: ctx is cancelled only
// after the group's grace, so a SIGTERM during the countdown would otherwise still swap the binary. On a
// drain nothing is swapped and update_failed is written while the database is still open.
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
		// Synchronous: the next step hands the process to the restart coordinator and a row in the async writer's
		// buffer would be lost. A failed write is logged, never a reason to leave a swapped binary unstarted.
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

// stopSignal says the process has begun to shut down. shutdown closes at the start of App.Close, draining
// only when the background group stops, much later; the group's ctx is cancelled later still, so it is never
// the signal. Either channel may be nil, which never fires.
type stopSignal struct {
	draining <-chan struct{}
	shutdown <-chan struct{}
}

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

// waitCountdown sleeps the countdown and reports whether it ran to the end. It also returns false when a
// shutdown began as the timer fired, so a started shutdown never goes on to swap the binary.
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

func refuseApplyShuttingDown(w http.ResponseWriter) {
	writeErr(w, http.StatusServiceUnavailable, httperr.CodeShuttingDown, "the server is shutting down — the update was not applied")
}

// updateOutcomeTimeout bounds the synchronous outcome row, which must be written even after ctx is cancelled.
const updateOutcomeTimeout = 5 * time.Second

// auditUpdateOutcome writes the outcome row synchronously; database is nil in tests without a store.
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

// applyStagedUpdate performs the on-disk swap: staged binary -> exePath, previous binary -> a unique
// exePath.old-*. On true the caller must request a restart, because exePath is no longer the running binary.
// The caller already broadcast "restarting in 5s", so every failure path must correct that promise or the
// client's banner counts down to a permanent "Reconnecting..."; the deferred broadcast is that guard, and
// committed=true cancels it. It does NOT spawn, signal or exit: restart is the main package's job after run()
// drained (Server/internal/app/restart.go), which also keeps the swap unit-testable. The name is unique
// because an earlier binary can still be running: on Windows a console server stays behind until its
// replacement exits (updater.SpawnReplacement), and its image cannot be replaced or removed.
func applyStagedUpdate(hub HubBroadcaster, exePath, newPath, stagedHash string, stopping func() bool) bool {
	committed := false
	defer func() {
		if !committed && hub != nil {
			hub.BroadcastServerRestart(ws.RestartReasonUpdateAborted, 0)
		}
	}()

	// TOCTOU guard: verify the hash through one open handle and commit (rename) that exact file, so the bytes
	// verified are the bytes the restart executes.
	staged, err := updater.OpenVerifiedBinary(newPath, stagedHash)
	if err != nil {
		slog.Error("update: staged binary re-verification failed, aborting update", "error", err)
		return false
	}
	defer staged.Close() //nolint:errcheck

	// Last chance to honour a shutdown that landed since the countdown ended; nothing is renamed yet.
	if stopping != nil && stopping() {
		slog.Info("update: shutdown began before the swap, leaving the running binary in place")
		return false
	}

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
		// Whatever is at exePath now is not the verified binary; restoring the previous one replaces it.
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
