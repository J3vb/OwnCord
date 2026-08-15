//go:build linux || darwin

package db

import (
	"errors"
	"os"
	"syscall"
)

// tryLockFile takes a non-blocking exclusive flock on path. The lock is tied
// to the open descriptor, so it vanishes with the process no matter how it
// dies — there is no stale-lock failure mode.
func tryLockFile(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600) //nolint:gosec // sidecar of the configured db path
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil { //nolint:gosec // G115: fd of a just-opened file is far below int range
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, errAlreadyLocked
		}
		return nil, err
	}
	return func() {
		// Unlock before close is redundant (close releases flock) but keeps
		// the intent explicit. The file itself is left behind on purpose:
		// removing it opens an inode-swap race with a concurrent acquirer,
		// and a leftover zero-byte .lock file is harmless.
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) //nolint:gosec // G115: same fd as above
		_ = f.Close()
	}, nil
}
