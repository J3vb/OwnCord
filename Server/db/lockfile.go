package db

import (
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ErrAlreadyLocked reports that another live process holds the database's
// single-process lock. The locks used here (flock on Unix, an exclusive file
// handle on Windows) are released by the OS when their holder exits, so a
// held lock always means a running process, never a stale file.
var ErrAlreadyLocked = errors.New("database lock held by another process")

// AcquireProcessLock takes the database's single-process lock for dbPath and
// returns its release, for short-lived tooling (the `chatserver restore` CLI)
// that must refuse when a server is already running rather than swap the file
// under it. It tries once with no retry window, since an operator wants a fast
// refusal. A refusal wraps ErrAlreadyLocked; any other error means the lock
// file could not be opened at all (e.g. its directory is missing).
func AcquireProcessLock(dbPath string) (release func(), err error) {
	release, err = tryLockFile(lockFilePath(dbPath))
	if errors.Is(err, ErrAlreadyLocked) {
		return nil, fmt.Errorf("database %s is in use by another process (stop the server first): %w", dbPath, err)
	}
	if err != nil {
		return nil, fmt.Errorf("could not take the process lock for database %s: %w", dbPath, err)
	}
	return release, nil
}

// lockFilePath is the sidecar lock file next to the SQLite database.
func lockFilePath(dbPath string) string { return dbPath + ".lock" }

// acquireProcessLock takes the single-process lock for dbPath, retrying for a
// bounded window before giving up with ErrAlreadyLocked.
//
// A restart handoff does not overlap by design: the old process closes the
// database (releasing this lock) before its replacement starts, in both spawn
// and supervised modes (Server/internal/app/restart.go). The retry is a safety
// net for cases that can still race: a supervisor relaunching the service while
// a wedged predecessor is being killed, and a final update from a release that
// still spawned mid-drain. A genuinely concurrent second process still fails,
// after the wait.
func acquireProcessLock(dbPath string) (release func(), err error) {
	const (
		retryFor   = 30 * time.Second
		retryEvery = 500 * time.Millisecond
	)
	deadline := time.Now().Add(retryFor)
	logged := false
	for {
		release, err = tryLockFile(lockFilePath(dbPath))
		if err == nil || !errors.Is(err, ErrAlreadyLocked) {
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
