//go:build windows

package admin

import (
	"io/fs"
	"syscall"
	"testing"
)

func TestLogFileGone_SharingViolationDuringDelete(t *testing.T) {
	err := &fs.PathError{Op: "open", Path: "owncord-2026-10-30.log", Err: syscall.Errno(32)}
	if !logFileGone(err) || !logFileBusy(err) {
		t.Fatal("a sharing violation must read as a file being deleted")
	}
	if !logFileGone(&fs.PathError{Op: "open", Path: "x", Err: syscall.Errno(5)}) {
		t.Fatal("access denied on a delete-pending file must read as gone")
	}
}
