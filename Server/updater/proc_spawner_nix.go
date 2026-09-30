//go:build !windows

package updater

import (
	"os"
	"os/exec"
	"syscall"
)

// SpawnReplacement starts the replacement server in a session of its own.
// It never needs this process to stay behind, so wait is always nil.
func SpawnReplacement(exePath string, args []string) (wait func() int, err error) {
	return nil, SpawnDetached(exePath, args)
}

// SpawnDetached starts the replacement server in a session of its own.
func SpawnDetached(exePath string, args []string) error {
	cmd := exec.Command(exePath, args...) //nolint:gosec // G204: exePath is the server's own binary path, validated by the caller
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}

	return cmd.Start()
}
