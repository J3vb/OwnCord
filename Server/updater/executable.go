package updater

import (
	"os"
	"path/filepath"
)

// Resolve at process startup, before an update can rename the running image.
// On Linux os.Executable follows /proc/self/exe: after the swap it returns
// the backup's .old path, which would restart the previous version.
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
