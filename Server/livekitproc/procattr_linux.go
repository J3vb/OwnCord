//go:build linux

package livekitproc

import (
	"os"
	"syscall"
)

// liveKitSysProcAttr has the kernel SIGKILL the companion if this process dies
// without its own teardown (kill -9, OOM, backstop force-exit), so an orphaned
// livekit-server cannot keep TCP 7880 and the UDP media range bound. Normal stop
// is still Process.Stop. Linux-only (PR_SET_PDEATHSIG); Windows uses a job object.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
}

// containLiveKitProcess is a no-op: Pdeathsig already ties the companion to this process.
func containLiveKitProcess(*os.Process) error { return nil }
