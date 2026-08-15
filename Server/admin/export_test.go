package admin

import (
	"errors"
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

// ApplyStagedUpdate exposes applyStagedUpdate (the on-disk swap + respawn
// logic behind POST /updates/apply's background goroutine) so tests can drive
// its abort paths directly with fake filesystem paths, instead of exercising
// the full HTTP handler — which resolves exePath via os.Executable() and
// would rename/replace the running test binary itself.
var ApplyStagedUpdate = applyStagedUpdate

// StubRestart replaces the process-restart hook for the duration of a test and
// returns a func reporting whether a restart was requested. Without this the
// restore handler would respawn and os.Exit the test binary.
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
	}
}
