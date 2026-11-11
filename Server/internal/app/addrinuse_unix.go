//go:build !windows

package app

import (
	"errors"
	"syscall"
)

// errnoIsAddrInUse reports whether err wraps EADDRINUSE.
func errnoIsAddrInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
