//go:build !windows

package admin

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// binarySafeFromServerUser reports whether the server's own user neither owns
// nor can write path. It is the unix half of the executed-binary guard.
func binarySafeFromServerUser(path string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	if st.Uid == uint32(os.Geteuid()) {
		return false
	}
	return unix.Access(path, unix.W_OK) != nil
}
