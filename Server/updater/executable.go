package updater

import (
	"fmt"
	"os"
	"path/filepath"
)

// Resolve at process startup, before an update can rename the running image.
// On Linux os.Executable follows /proc/self/exe: after the swap it returns
// the backup's .old-* path, which would restart the previous version.
var startupExecutablePath, startupExecutableErr = resolveExecutablePath()

// ExecutablePath returns the canonical installation path captured at startup.
// Update staging, restart handoff and backup cleanup must all use this same
// path, even after the running executable has been renamed by an update.
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
// the file a self-update creates next to the binary. It creates and removes a
// probe file there, so a read-only install folder is reported before any
// download starts. The ".old-" infix is deliberate: if the process dies
// between create and remove, the boot cleanup (removeOldBinaryAt) matches the
// leftover by that prefix and deletes it.
//
// A nil result does not promise the swap succeeds, only that the directory is
// writable; the swap itself still reports its own failures.
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
		return fmt.Errorf("removing install directory probe: %w", removeErr)
	}
	return nil
}
