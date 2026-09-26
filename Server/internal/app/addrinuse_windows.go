//go:build windows

package app

import (
	"errors"
	"syscall"
)

// wsaeAddrInUse is WSAEADDRINUSE (10048), the errno a Windows bind conflict
// actually carries. The standard syscall package does not export it (it
// lives in golang.org/x/sys/windows, which this module does not depend on
// directly), and syscall.EADDRINUSE on Windows is Go's distinct
// APPLICATION_ERROR-block value that errors.Is does not map to WSA codes.
const wsaeAddrInUse = syscall.Errno(10048)

// errnoIsAddrInUse unwraps err (net.OpError → os.SyscallError → Errno) and
// compares against both Windows bind-conflict errnos.
func errnoIsAddrInUse(err error) bool {
	return errors.Is(err, wsaeAddrInUse) || errors.Is(err, syscall.EADDRINUSE)
}
