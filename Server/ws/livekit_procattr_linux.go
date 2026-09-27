//go:build linux

package ws

import (
	"os"
	"syscall"
)

// liveKitSysProcAttr asks the kernel to SIGKILL the companion livekit-server
// if this process dies without running its own teardown (kill -9, OOM kill,
// a wedged shutdown force-exited by the restart backstop). The normal stop
// path is still LiveKitProcess.Stop via hub.GracefulStop — this only closes
// the hole where an orphaned livekit-server keeps TCP 7880 and the UDP media
// range bound, crash-looping the successor's LiveKit until someone kills the
// orphan by hand.
//
// Pdeathsig is Linux-only (prctl PR_SET_PDEATHSIG); Windows uses a job
// object instead (livekit_procattr_windows.go).
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

// containLiveKitProcess is a no-op: Pdeathsig already ties the companion to
// this process.
func containLiveKitProcess(*os.Process) error { return nil }
