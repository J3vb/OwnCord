//go:build windows

package app

import "log/slog"

// raiseFileLimit is a no-op on Windows, which has no RLIMIT_NOFILE.
func raiseFileLimit(*slog.Logger, int) {}
