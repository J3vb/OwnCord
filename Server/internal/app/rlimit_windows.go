//go:build windows

package app

import "log/slog"

// raiseFileLimit is a no-op on Windows: the platform has no RLIMIT_NOFILE,
// and the handle ceiling is not something a process raises for itself.
func raiseFileLimit(*slog.Logger, int) {}
