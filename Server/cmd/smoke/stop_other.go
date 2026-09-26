//go:build !windows

package main

import (
	"os"
	"syscall"
)

// gracefulStopName names the stop this platform can actually deliver, so a
// failure message says which mechanism was tried.
const gracefulStopName = "SIGTERM"

// newProcessGroup isolates the server in its own process group so the signal
// below reaches it alone, never the harness or its siblings.
func newProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

func stopGracefully(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}
