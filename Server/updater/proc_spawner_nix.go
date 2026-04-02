//go:build !windows

package updater

import (
	"os"
	"os/exec"
	"syscall"
)

// SpawnDetached starts a new process that is not attached to the current one.
func SpawnDetached(exePath string, args []string) error {
	cmd := exec.Command(exePath, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}

	return cmd.Start()
}
