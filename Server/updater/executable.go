package updater

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// Resolve at startup, before an update renames the running image: on Linux os.Executable follows
// /proc/self/exe and would return the backup's .old-* path, restarting the previous version.
var startupExecutablePath, startupExecutableErr = resolveExecutablePath()

// ExecutablePath returns the installation path captured at startup, which
// update staging, restart handoff and backup cleanup must all use.
func ExecutablePath() (string, error) {
	return startupExecutablePath, startupExecutableErr
}

func resolveExecutablePath() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exePath)
}

// CanReplaceExecutable reports whether the directory holding exePath accepts
// the file a self-update creates, using a probe file, so a read-only install
// folder is reported before any download. The ".old-" infix is deliberate: boot
// cleanup (removeOldBinaryAt) matches a probe orphaned by a crash by that prefix.
// A nil result promises writability, not that the swap succeeds.
func CanReplaceExecutable(exePath string) error {
	dir := filepath.Dir(exePath)
	probe, err := os.CreateTemp(dir, filepath.Base(exePath)+".old-probe-*")
	if err != nil {
		return fmt.Errorf("install directory %s is not writable: %w", dir, err)
	}
	name := probe.Name()
	closeErr := probe.Close()
	removeErr := os.Remove(name)
	if closeErr != nil {
		return fmt.Errorf("closing install directory probe: %w", closeErr)
	}
	if removeErr != nil {
		// The create proved the folder writable; a file briefly held open (antivirus) is left for boot cleanup.
		slog.Debug("install directory probe not removed", "path", name, "err", removeErr)
	}
	return nil
}
