//go:build windows

package updater

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnDetached starts a new process that is not attached to the current one.
//
// The replacement gets a console of its own (CREATE_NEW_CONSOLE), never none
// (DETACHED_PROCESS): a windowless server cannot be stopped by closing its
// console, and the livekit-server it launches would get a console window of
// its own whose close kills only LiveKit, which the supervisor then respawns.
// With a console, LiveKit inherits it and one close stops both.
func SpawnDetached(exePath string, args []string) error {
	if isConsole(os.Stdout) && isConsole(os.Stderr) {
		return startInNewConsole(exePath, args)
	}
	// Output is redirected (e.g. `chatserver.exe >> server.log`): keep the
	// redirect, but not a stream still pointing at the old console, whose
	// window nothing will be attached to once this process exits.
	cmd := exec.Command(exePath, args...) //nolint:gosec // G204: exePath is the server's own binary path, validated by the caller
	if !isConsole(os.Stdout) {
		cmd.Stdout = os.Stdout
	}
	if !isConsole(os.Stderr) {
		cmd.Stderr = os.Stderr
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_CONSOLE}
	return cmd.Start()
}

// startInNewConsole calls CreateProcess directly because os/exec always passes
// standard handles (the null device when unset), which would leave the new
// console's window blank. Without STARTF_USESTDHANDLES the child writes to
// the console it is given.
func startInNewConsole(exePath string, args []string) error {
	exe, err := windows.UTF16PtrFromString(exePath)
	if err != nil {
		return err
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exePath}, args...)))
	if err != nil {
		return err
	}
	si := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	var pi windows.ProcessInformation
	if err := windows.CreateProcess(exe, cmdLine, nil, nil, false,
		windows.CREATE_NEW_CONSOLE, nil, nil, &si, &pi); err != nil {
		return &os.PathError{Op: "CreateProcess", Path: exePath, Err: err}
	}
	_ = windows.CloseHandle(pi.Thread)
	_ = windows.CloseHandle(pi.Process)
	return nil
}

// isConsole reports whether f is a console rather than a file or pipe. An
// unusable handle counts as a console: there is no redirect to preserve.
func isConsole(f *os.File) bool {
	fi, err := f.Stat()
	return err != nil || fi.Mode()&os.ModeCharDevice != 0
}
