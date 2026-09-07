//go:build windows

package ws

import "os"

// Windows has no os.Process equivalent of SIGTERM. Terminate the owned
// process; runLoop still waits for exit before releasing the update handoff.
func stopLiveKitProcess(process *os.Process) error {
	return process.Kill()
}
