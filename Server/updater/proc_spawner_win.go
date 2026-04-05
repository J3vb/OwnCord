//go:build windows

package updater

import (
	"os"
	"os/exec"
	"syscall"
)

// SpawnDetached starts a new process that is not attached to the current one.
func SpawnDetached(exePath string, args []string) error {
	cmd := exec.Command(exePath, args...) //nolint:gosec // G204: exePath is the server's own binary path, validated by the caller
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008, // DETACHED_PROCESS
	}

	return cmd.Start()
}
