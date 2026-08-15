//go:build !linux && !darwin && !windows

package db

import "errors"

// tryLockFile has no implementation on this platform; openFile logs a warning
// and continues without the single-process guard.
func tryLockFile(string) (func(), error) {
	return nil, errors.ErrUnsupported
}
