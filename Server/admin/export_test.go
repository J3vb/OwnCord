package admin

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
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

// SetSetupLimiterReapTiming overrides the interval and max-window the setup
// endpoint's rate-limiter reaper uses, so tests don't wait on the real
// 5-minute interval.
func SetSetupLimiterReapTiming(interval, maxWindow time.Duration) (restore func()) {
	prevI, prevW := setupLimiterReapInterval, setupLimiterReapMaxWindow
	setupLimiterReapInterval = interval
	setupLimiterReapMaxWindow = maxWindow
	return func() {
		setupLimiterReapInterval = prevI
		setupLimiterReapMaxWindow = prevW
	}
}

// SetBackupBaseDir overrides backupBaseDir so tests can point backup handlers
// at a temp dir. Lives here so it stays out of the production binary.
func SetBackupBaseDir(dir string) { backupBaseDir = dir }

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

// StubCopyBackup swaps the restore path's file-copy hook so tests can inject
// mid-copy failures that pass the pre-copy integrity gate. CopyBackupForTest
// is the real implementation, for stubs that only want to fail once.
func StubCopyBackup(fn func(src, dst string) error) (restore func()) {
	prev := copyBackupFile
	copyBackupFile = fn
	return func() { copyBackupFile = prev }
}

// CopyBackupForTest exposes the real copyFile for StubCopyBackup delegates.
var CopyBackupForTest = copyFile

// StubCloseError makes the next handleRestoreBackup call's database.Close()
// return err instead of actually closing the pools, so tests can exercise the
// Close-failure branch without a genuine driver-level close error (see
// dbCloser's doc comment for why that's not otherwise reachable in a test).
func StubCloseError(msg string) (restore func()) {
	closeMu.Lock()
	prev := dbCloser
	dbCloser = func(*db.DB) error { return errors.New(msg) }
	closeMu.Unlock()
	return func() {
		closeMu.Lock()
		dbCloser = prev
		closeMu.Unlock()
	}
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
