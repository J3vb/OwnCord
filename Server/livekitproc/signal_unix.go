//go:build !windows

package livekitproc

import (
	"os"
	"syscall"
)

// stopLiveKitProcess lets LiveKit close rooms; exec.Cmd.WaitDelay escalates to Kill.
func stopLiveKitProcess(process *os.Process) error {
	return process.Signal(syscall.SIGTERM)
}
