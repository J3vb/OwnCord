//go:build windows

package livekitproc

import "os"

// Windows has no SIGTERM equivalent: terminate the process; runLoop still waits for exit.
func stopLiveKitProcess(process *os.Process) error {
	return process.Kill()
}
