//go:build windows

package updater

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SpawnReplacement starts the replacement server. With non-nil wait this
// process stays behind: wait blocks until the replacement exits and returns the
// exit code this process then exits with.
//
// The replacement always has a console (never DETACHED_PROCESS): a windowless
// server cannot be stopped by closing its console, and its livekit-server would
// get its own console whose close kills only LiveKit, which the supervisor
// respawns. Started from a console, it restarts into that window (inherited
// console and streams) and this process waits, so a tracking console host stays
// open and a shell does not print its prompt over the log. The waiter leaves
// Ctrl+C to the replacement; it keeps its image locked, which is why an update
// moves the running binary aside under a unique .old-* name.
func SpawnReplacement(exePath string, args []string) (wait func() int, err error) {
	if hasConsole() {
		cmd := exec.Command(exePath, args...) //nolint:gosec // G204: exePath is the server's own binary path, validated by the caller
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		// Not signal.Ignore: on Windows an unwanted Ctrl+C falls through to the default handler, which ends the
		// process.
		signal.Notify(make(chan os.Signal, 1), os.Interrupt)
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return func() int {
			_ = cmd.Wait()
			return cmd.ProcessState.ExitCode()
		}, nil
	}
	// No console (started detached, e.g. by a service wrapper).
	return nil, SpawnDetached(exePath, args)
}

// SpawnDetached starts the replacement in a new console and never waits. The
// restart backstop uses it even on a console: a wedged predecessor must exit,
// so the replacement cannot share a window that would close with it.
func SpawnDetached(exePath string, args []string) error {
	if isConsole(os.Stdout) && isConsole(os.Stderr) {
		return startInNewConsole(exePath, args)
	}
	// Keep a redirected output (e.g. a wrapper's log file); a stream that is not a
	// file or pipe (unusable handle, NUL) is left for the new console.
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
// standard handles, which would leave the new console blank; without
// STARTF_USESTDHANDLES the child writes to the console it is given.
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

// hasConsole reports whether this process is attached to a console, redirected streams or not.
func hasConsole() bool {
	name, err := windows.UTF16PtrFromString("CONOUT$")
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(name, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}

// isConsole reports whether f is a console; an unusable handle counts as one (no redirect to preserve).
func isConsole(f *os.File) bool {
	fi, err := f.Stat()
	return err != nil || fi.Mode()&os.ModeCharDevice != 0
}
