//go:build unix

package db

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// matchLiveOwner gives the staged copy the live database's mode and owner, so
// the renamed-in file stays usable by the service account when an operator
// runs the offline restore as another user (root, say). No live database
// leaves the copy as created.
func matchLiveOwner(livePath string, f *os.File) error {
	info, err := os.Stat(livePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading the live database's owner: %w", err)
	}
	if err := f.Chmod(info.Mode().Perm()); err != nil {
		return fmt.Errorf("matching the live database's mode: %w", err)
	}
	live, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	mine, err := f.Stat()
	if err != nil {
		return fmt.Errorf("reading the staged copy's owner: %w", err)
	}
	if own, ok := mine.Sys().(*syscall.Stat_t); ok && own.Uid == live.Uid && own.Gid == live.Gid {
		return nil
	}
	if err := f.Chown(int(live.Uid), int(live.Gid)); err != nil { //nolint:gosec // G115: uid/gid fit in int on every unix Go supports
		return fmt.Errorf("matching the live database's owner (run the restore as the server's user): %w", err)
	}
	return nil
}
