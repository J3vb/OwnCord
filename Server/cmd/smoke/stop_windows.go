//go:build windows

package main

import (
	"fmt"
	"math"
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

// gracefulStopName names the stop this platform can actually deliver, so a
// failure message says which mechanism was tried.
const gracefulStopName = "CTRL_BREAK"

// newProcessGroup puts the server in its own console process group. Windows
// has no SIGTERM: console control events are the only graceful stop the OS
// offers, and one can be addressed to a process group but not to a lone pid.
// Go's runtime maps CTRL_BREAK to os.Interrupt, which the server's
// signal.NotifyContext already listens for, so this reaches the same teardown
// path SIGTERM reaches on Linux.
func newProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

func stopGracefully(p *os.Process) error {
	// Windows process ids are DWORDs, so this conversion is always exact. The
	// guard states that rather than leaving it to be trusted.
	if p.Pid < 0 || int64(p.Pid) > math.MaxUint32 {
		return fmt.Errorf("process id %d is out of range for a console control event", p.Pid)
	}
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(p.Pid))
}
