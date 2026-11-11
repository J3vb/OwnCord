package db

import (
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ErrAlreadyLocked reports that another live process holds the database's
// single-process lock (flock on Unix, an exclusive handle on Windows); the OS releases
// it when the holder exits.
var ErrAlreadyLocked = errors.New("database lock held by another process")

// AcquireProcessLock takes the single-process lock for dbPath and returns its release,
// for short-lived tooling (the `chatserver restore` CLI) that must refuse when a
// server is running. It tries once; a refusal wraps ErrAlreadyLocked.
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

func lockFilePath(dbPath string) string { return dbPath + ".lock" }

// acquireProcessLock takes the lock for dbPath, retrying for a bounded window
// before ErrAlreadyLocked. A restart handoff does not overlap by design (the old
// process closes the database first, Server/internal/app/restart.go); the retry
// covers a supervisor relaunching while a wedged predecessor is killed, or a
// final update that spawned mid-drain. A genuinely concurrent process still fails after the wait.
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
