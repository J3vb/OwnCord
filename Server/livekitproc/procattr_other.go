//go:build !linux && !windows

package livekitproc

import (
	"os"
	"syscall"
)

// liveKitSysProcAttr returns nil: parent-death signaling is Linux-only and
// macOS has no equivalent, so the companion stops only via Process.Stop.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return nil
}

func containLiveKitProcess(*os.Process) error { return nil }
