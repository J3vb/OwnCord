//go:build windows

package db

import (
	"errors"
	"syscall"
)

// errorSharingViolation is Windows' ERROR_SHARING_VIOLATION (32): the file is
// open in another process with an incompatible share mode.
const errorSharingViolation = syscall.Errno(32)

// tryLockFile opens path with an empty share mode, so a second process's open
// fails with a sharing violation until this handle is closed. The handle is
// released by the OS when the process exits — no stale-lock failure mode.
func tryLockFile(path string) (func(), error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(
		p,
		syscall.GENERIC_READ|syscall.GENERIC_WRITE,
		0, // no sharing
		nil,
		syscall.OPEN_ALWAYS,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		if errors.Is(err, errorSharingViolation) {
			return nil, errAlreadyLocked
		}
		return nil, err
	}
	return func() { _ = syscall.CloseHandle(h) }, nil
}
