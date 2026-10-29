package admin

import (
	"context"
	"github.com/J3vb/OwnCord/Server/updater"
	"sync"
	"sync/atomic"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
)

// CaptureSetupLimiter installs h so the next NewAdminAPI call reports the
// *auth.RateLimiter it creates for the /setup endpoint. NewAdminAPI returns
// only an http.Handler, so this is the only way tests can reach that limiter
// to check whether its stale entries get reaped.
func CaptureSetupLimiter(h func(*auth.RateLimiter)) (restore func()) {
	prev := setupLimiterHook
	setupLimiterHook = h
	return func() { setupLimiterHook = prev }
}

// OwnerOnlyRoutesForTest returns the routes api registered through
// ownerOnly. Test-only surface (the route-walk test, P2-13 Codex review).
func OwnerOnlyRoutesForTest(api *AdminAPI) []OwnerOnlyRoute { return api.ownerOnlyRoutes() }

// SharesOwnerOnlyRegistryForTest reports whether a and b record owner-only
// routes in the same registry.
func SharesOwnerOnlyRegistryForTest(a, b *AdminAPI) bool {
	return &a.owner == &b.owner || (len(a.owner.routes) > 0 && &a.owner.routes[0] == &b.owner.routes[0])
}

// SetArchiveBeforeSnapshotHook installs h to run synchronously between the
// archive's first plan and its database snapshot, the window an upload that
// the snapshot records can land in.
func SetArchiveBeforeSnapshotHook(h func()) (restore func()) {
	prev := archiveBeforeSnapshotHook
	archiveBeforeSnapshotHook = h
	return func() { archiveBeforeSnapshotHook = prev }
}

// SetArchiveLinkTTL overrides how long a single-use archive link stays valid,
// so the expiry test does not wait the real minute.
func SetArchiveLinkTTL(d time.Duration) (restore func()) {
	prev := archiveLinkTTL
	archiveLinkTTL = d
	return func() { archiveLinkTTL = prev }
}

// SetPatchChannelPostCommitHook installs h to run synchronously right after
// handlePatchChannel's AdminUpdateChannel commit, before the post-commit
// re-read and hub fan-out — the only way to deterministically land a caller
// cancellation in that exact window (OC-0158) instead of racing wall-clock
// timing.
func SetPatchChannelPostCommitHook(h func()) (restore func()) {
	prev := patchChannelPostCommitHook
	patchChannelPostCommitHook = h
	return func() { patchChannelPostCommitHook = prev }
}

// SetCreateChannelPostCommitHook installs h to run synchronously right after
// handleCreateChannel's AdminCreateChannel commit, before the post-commit
// re-read and hub fan-out — the create-side twin of
// SetPatchChannelPostCommitHook (OC-0158).
func SetCreateChannelPostCommitHook(h func()) (restore func()) {
	prev := createChannelPostCommitHook
	createChannelPostCommitHook = h
	return func() { createChannelPostCommitHook = prev }
}

// ApplyStagedUpdate exposes applyStagedUpdate (the on-disk swap behind
// POST /updates/apply's background goroutine) so tests can drive it directly
// with fake filesystem paths, instead of exercising the full HTTP handler —
// which resolves exePath via os.Executable() and would rename/replace the
// running test binary itself. The swap has no process side effects anymore
// (no spawn, no signal, no exit), so the success path is testable too.
var ApplyStagedUpdate = applyStagedUpdate

// ApplyAndRestart exposes the whole background tail (countdown broadcast →
// swap → restart request / guard release) for tests, combined with
// StubRestart and SetApplyRestartDelay.
var ApplyAndRestart = applyAndRestart

// NewStopSignal builds the shutdown signal applyAndRestart watches: draining
// is the background group's Draining channel, shutdown the process-wide one.
func NewStopSignal(draining, shutdown <-chan struct{}) stopSignal {
	return stopSignal{draining: draining, shutdown: shutdown}
}

// SetApplyRestartDelay shrinks the client-facing restart countdown so tests
// of applyAndRestart don't sleep the real 5 seconds.
func SetApplyRestartDelay(d time.Duration) (restore func()) {
	prev := applyRestartDelay
	applyRestartDelay = d
	return func() { applyRestartDelay = prev }
}

// ResetRestartState returns the restart-serialization guard to idle. Tests
// that drive a restart-committing path (restore, apply success, setup
// restart) must call it afterwards — the state is process-global and would
// otherwise 409 every later test's request.
func ResetRestartState() { restartState.Store(restartStateIdle) }

// ForceRestartState pins the guard for conflict-path tests: busy=false sets
// restart-pending, busy=true sets an in-flight exclusive operation.
func ForceRestartState(busy bool) {
	if busy {
		restartState.Store(restartStateBusy)
	} else {
		restartState.Store(restartStatePending)
	}
}

// CurrentRestartState reports the guard state by name for assertions.
func CurrentRestartState() string {
	switch restartState.Load() {
	case restartStateBusy:
		return "busy"
	case restartStatePending:
		return "pending"
	default:
		return "idle"
	}
}

// RequestRestartForTest exposes requestRestart so the unwired default hook's
// inertness (log, no exit, no spawn) is directly testable.
var RequestRestartForTest = requestRestart

// StubRestart replaces the process-restart hook for the duration of a test and
// returns a func reporting whether a restart was requested. Without this the
// restore handler's request would hit the unwired-hook error log; with it the
// test can assert the request happened. The restore func also returns the
// restart-serialization guard to idle, since any test that triggered the hook
// has necessarily left it in restart-pending.
func StubRestart() (restarted func() bool, restore func()) {
	restartMu.Lock()
	prev := restartSelf
	called := &atomic.Bool{}
	restartSelf = func(string) { called.Store(true) }
	restartMu.Unlock()
	return called.Load, func() {
		restartMu.Lock()
		restartSelf = prev
		restartMu.Unlock()
		ResetRestartState()
	}
}

// StubRestartCapture is StubRestart recording the reasons passed to the hook,
// for tests that assert which path requested the restart.
func StubRestartCapture() (reasons func() []string, restore func()) {
	restartMu.Lock()
	prev := restartSelf
	var mu sync.Mutex
	var got []string
	restartSelf = func(reason string) {
		mu.Lock()
		got = append(got, reason)
		mu.Unlock()
	}
	restartMu.Unlock()
	return func() []string {
			mu.Lock()
			defer mu.Unlock()
			return append([]string(nil), got...)
		}, func() {
			restartMu.Lock()
			restartSelf = prev
			restartMu.Unlock()
			ResetRestartState()
		}
}

// SetInstallWritable replaces the install-directory probe and returns a
// restore func, so tests can simulate a read-only install.
func SetInstallWritable(f func() error) (restore func()) {
	prev := installWritable
	installWritable = f
	return func() { installWritable = prev }
}

// SetDownloadAndVerify replaces the download stage of POST /updates/apply and
// returns a restore func.
func SetDownloadAndVerify(f func(u *updater.Updater, ctx context.Context, latest, dl, sum, sig, man, manSig, dest string) (string, error)) (restore func()) {
	prev := downloadAndVerify
	downloadAndVerify = f
	return func() { downloadAndVerify = prev }
}

// SetBackupHoldForTest installs h to run inside api's manual backup after the
// single-flight guard is taken and before the backup starts, the window a
// concurrent POST /backup must be refused in. nil clears it.
func SetBackupHoldForTest(api *AdminAPI, h func()) {
	if h == nil {
		api.backup.hold.Store(nil)
		return
	}
	api.backup.hold.Store(&h)
}

// FreeBackupPathForTest exposes freeBackupPath.
func FreeBackupPathForTest(dir, base string) (string, error) { return freeBackupPath(dir, base) }

// GatedRoutesForTest returns the routes api registered behind a routeGate
// (the owner-or-bit and administrator-or-bit routes, WP 8.4d), each with the
// name of its gate.
func GatedRoutesForTest(api *AdminAPI) []GatedRoute {
	return api.gatedRoutes()
}
