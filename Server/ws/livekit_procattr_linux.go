//go:build linux

package ws

import "syscall"

// liveKitSysProcAttr asks the kernel to SIGKILL the companion livekit-server
// if this process dies without running its own teardown (kill -9, OOM kill,
// a wedged shutdown force-exited by the restart backstop). The normal stop
// path is still LiveKitProcess.Stop via hub.GracefulStop — this only closes
// the hole where an orphaned livekit-server keeps TCP 7880 and the UDP media
// range bound, crash-looping the successor's LiveKit until someone kills the
// orphan by hand.
//
// Pdeathsig is Linux-only (prctl PR_SET_PDEATHSIG); other platforms return
// nil and rely on the graceful path alone.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}
