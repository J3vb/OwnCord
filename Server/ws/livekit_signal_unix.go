//go:build !windows

package ws

import (
	"os"
	"syscall"
)

// stopLiveKitProcess gives LiveKit a chance to close rooms and listeners.
// exec.Cmd.WaitDelay escalates to Kill if the grace period expires.
func stopLiveKitProcess(process *os.Process) error {
	return process.Signal(syscall.SIGTERM)
}
