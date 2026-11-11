//go:build windows

package app

import (
	"errors"
	"syscall"
)

// wsaeAddrInUse is WSAEADDRINUSE (10048); syscall does not export it and
// syscall.EADDRINUSE is a distinct value on Windows.
const wsaeAddrInUse = syscall.Errno(10048)

// errnoIsAddrInUse reports whether err wraps either Windows bind-conflict
// errno.
func errnoIsAddrInUse(err error) bool {
	return errors.Is(err, wsaeAddrInUse) || errors.Is(err, syscall.EADDRINUSE)
}
