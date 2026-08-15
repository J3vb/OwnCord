package admin

import (
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
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
