//go:build windows

package app

import (
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

var procSetConsoleCtrlHandler = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")

var logoffFilter struct {
	once      sync.Once
	installed bool
	err       error
}

// installLogoffFilter registers, once per process, a console control handler that consumes the events
// consumeConsoleCtrl names. Windows calls the newest handler first and the runtime registers its own before
// main, so a consumed event never becomes SIGTERM. It installs nothing outside the services session, and it
// stays for the life of the process.
func installLogoffFilter() (installed bool, err error) {
	logoffFilter.once.Do(func() {
		logoffFilter.installed, logoffFilter.err = registerLogoffFilter()
	})
	return logoffFilter.installed, logoffFilter.err
}

func registerLogoffFilter() (bool, error) {
	var session uint32
	if err := windows.ProcessIdToSessionId(windows.GetCurrentProcessId(), &session); err != nil {
		return false, fmt.Errorf("reading the process's session: %w", err)
	}
	if session != servicesSession {
		return false, nil
	}
	handler := windows.NewCallback(func(event uint32) uintptr {
		if consumeConsoleCtrl(event, session) {
			return 1
		}
		return 0
	})
	if ok, _, callErr := procSetConsoleCtrlHandler.Call(handler, 1); ok == 0 {
		return false, fmt.Errorf("registering the console control handler: %w", callErr)
	}
	return true, nil
}
