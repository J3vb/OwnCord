//go:build windows

package admin

import (
	"errors"
	"io/fs"
	"syscall"
)

// errorSharingViolation is Windows' ERROR_SHARING_VIOLATION (32).
const errorSharingViolation = syscall.Errno(32)

// logFileGone reports whether an open failed because the cleanup deleted the
// file. While Windows deletes a file, a new open fails with a sharing
// violation, and once deleted the name stays listed until its last handle
// closes, where an open fails with access denied.
func logFileGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) || errors.Is(err, errorSharingViolation)
}

// logFileBusy reports whether an open may succeed if tried again shortly.
func logFileBusy(err error) bool {
	return errors.Is(err, errorSharingViolation)
}
