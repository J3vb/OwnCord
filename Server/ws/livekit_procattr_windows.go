//go:build windows

package ws

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// liveKitSysProcAttr returns nil: the companion inherits this process's
// console, so closing that console stops both. Dying with the parent is
// handled by the job object in containLiveKitProcess instead.
func liveKitSysProcAttr() *syscall.SysProcAttr {
	return nil
}

// liveKitJob is the job object every companion livekit-server joins. Its
// handle is never closed: the kernel closes it when this process exits by any
// route (console close, Task Manager kill, crash, backstop os.Exit), and
// KILL_ON_JOB_CLOSE then kills the companion — the Windows counterpart of
// Linux's Pdeathsig. Without it an orphaned livekit-server keeps TCP 7880 and
// the UDP media range bound.
var liveKitJob = sync.OnceValues(newKillOnCloseJob)

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("creating job object: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil { //nolint:gosec // G103: SetInformationJobObject takes the struct by pointer
		_ = windows.CloseHandle(job)
		return 0, fmt.Errorf("setting kill-on-close on job object: %w", err)
	}
	return job, nil
}

func assignProcessToJob(job windows.Handle, process *os.Process) error {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.Pid)) //nolint:gosec // G115: a Windows PID is a DWORD
	if err != nil {
		return fmt.Errorf("opening process %d: %w", process.Pid, err)
	}
	defer windows.CloseHandle(h) //nolint:errcheck // best-effort close of a query handle
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		return fmt.Errorf("assigning process %d to job object: %w", process.Pid, err)
	}
	return nil
}

// containLiveKitProcess ties a just-started companion's lifetime to this
// process by adding it to liveKitJob.
func containLiveKitProcess(process *os.Process) error {
	job, err := liveKitJob()
	if err != nil {
		return err
	}
	return assignProcessToJob(job, process)
}
