//go:build !linux && !windows

package ws

import (
	"os"
	"syscall"
)

// liveKitSysProcAttr returns nil: parent-death signaling (Pdeathsig) is a
// Linux prctl feature and macOS has no equivalent, so there the companion
// livekit-server is stopped only by the graceful path (LiveKitProcess.Stop
// via hub.GracefulStop). Linux and Windows have their own files.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return nil
}

func containLiveKitProcess(*os.Process) error { return nil }
