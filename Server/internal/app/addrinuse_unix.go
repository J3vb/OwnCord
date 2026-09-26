//go:build !windows

package app

import (
	"errors"
	"syscall"
)

// errnoIsAddrInUse unwraps err (net.OpError → os.SyscallError → Errno) and
// compares against EADDRINUSE.
func errnoIsAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
