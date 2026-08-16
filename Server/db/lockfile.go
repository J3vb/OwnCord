package db

import (
	"errors"
	"log/slog"
	"time"
)

// errAlreadyLocked reports that another live process holds the database's
// single-process lock. The locks used here (flock on Unix, an exclusive file
// handle on Windows) are released by the OS when their holder exits, so a
// held lock always means a running process, never a stale file.
var errAlreadyLocked = errors.New("database lock held by another process")

// lockFilePath is the sidecar lock file next to the SQLite database.
func lockFilePath(dbPath string) string { return dbPath + ".lock" }

// acquireProcessLock takes the single-process lock for dbPath, retrying for
// a bounded window before giving up with errAlreadyLocked.
//
// The restart handoff no longer overlaps by design — the old process closes
// the database (releasing this lock) and exits before its replacement is
// started, in both spawn and supervised restart modes (Server/restart.go).
// The retry survives as a safety net for the cases that can still race: a
// supervisor relaunching the service while a wedged predecessor is being
// backstop-killed, and the final old-style update from a release that still
// spawned mid-drain. A genuinely concurrent long-lived second process still
// fails, just after the wait.
func acquireProcessLock(dbPath string) (release func(), err error) {
	const (
		retryFor   = 30 * time.Second
		retryEvery = 500 * time.Millisecond
	)
	deadline := time.Now().Add(retryFor)
	logged := false
	for {
		release, err = tryLockFile(lockFilePath(dbPath))
		if err == nil || !errors.Is(err, errAlreadyLocked) {
			return release, err
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		if !logged {
			slog.Info("db: database is locked by another process; waiting for it to exit (restart handoff)",
				"path", dbPath, "wait_up_to", retryFor.String())
			logged = true
		}
		time.Sleep(retryEvery)
	}
}
