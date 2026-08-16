//go:build linux

package ws

import (
	"syscall"
	"testing"
)

// The companion livekit-server must die with a parent that never ran its
// teardown (kill -9, OOM, backstop force-exit): without Pdeathsig the orphan
// keeps 7880/UDP bound and the successor's LiveKit crash-loops.
func TestLiveKitSysProcAttr_SetsPdeathsig(t *testing.T) {
	attr := liveKitSysProcAttr()
	if attr == nil {
		t.Fatal("liveKitSysProcAttr() = nil on linux, want Pdeathsig attr")
	}
	if attr.Pdeathsig != syscall.SIGKILL {
		t.Errorf("Pdeathsig = %v, want SIGKILL", attr.Pdeathsig)
	}
}
