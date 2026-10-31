//go:build !windows

package admin

import (
	"errors"
	"io/fs"
)

// logFileGone reports whether an open failed because the cleanup deleted the
// file.
func logFileGone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission)
}

// logFileBusy reports whether an open may succeed if tried again shortly.
func logFileBusy(error) bool {
	return false
}
