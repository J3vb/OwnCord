//go:build windows

package app

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestConsoleCtrlConstantsMatchWindows(t *testing.T) {
	if ctrlLogoffEvent != windows.CTRL_LOGOFF_EVENT {
		t.Fatalf("ctrlLogoffEvent = %d, want CTRL_LOGOFF_EVENT (%d)", ctrlLogoffEvent, windows.CTRL_LOGOFF_EVENT)
	}
}

// The filter installs in the services session and nowhere else, and asking
// again returns the first answer rather than registering a second handler.
func TestInstallLogoffFilter(t *testing.T) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		t.Fatalf("ProcessIdToSessionId: %v", err)
	}
	installed, err := installLogoffFilter()
	if err != nil {
		t.Fatalf("installLogoffFilter: %v", err)
	}
	if want := session == servicesSession; installed != want {
		t.Fatalf("installed = %v in session %d, want %v", installed, session, want)
	}
	again, err := installLogoffFilter()
	if again != installed || err != nil {
		t.Fatalf("second call = (%v, %v), want (%v, nil)", again, err, installed)
	}
}
