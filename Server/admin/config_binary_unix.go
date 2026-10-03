//go:build !windows

package admin

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// binaryExecutable reports whether info carries an execute bit. Unix enforces
// execute permission, so a missing bit is a real refusal.
func binaryExecutable(info os.FileInfo) bool {
	return info.Mode().Perm()&0o111 != 0
}

// binarySafeFromServerUser reports whether the server's own user neither owns
// nor can write path. It is the unix half of the executed-binary guard.
func binarySafeFromServerUser(path string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return false
	}
	if int64(st.Uid) == int64(os.Geteuid()) {
		return false
	}
	return unix.Access(path, unix.W_OK) != nil
}
