//go:build windows

package app

import "log/slog"

// startFileLimit is the start step's Windows arm. The platform has no
// RLIMIT_NOFILE, and the handle ceiling is not something a process raises for
// itself, so the step does nothing. It exists so lifecycle.go names one stage
// on every platform.
func (a *App) startFileLimit() error {
	raiseFileLimit(a.log, a.cfg.Server.MaxWSConnections)
	return nil
}

// raiseFileLimit is a no-op on Windows: the platform has no RLIMIT_NOFILE,
// and the handle ceiling is not something a process raises for itself.
func raiseFileLimit(*slog.Logger, int) {}
