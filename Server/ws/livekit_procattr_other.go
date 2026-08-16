//go:build !linux

package ws

import "syscall"

// liveKitSysProcAttr returns nil: parent-death signaling (Pdeathsig) is a
// Linux prctl feature. On Windows and macOS the companion livekit-server is
// stopped only by the graceful path (LiveKitProcess.Stop via
// hub.GracefulStop); a Windows job object would be the equivalent hardening
// and is deliberately out of scope here.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return nil
}
