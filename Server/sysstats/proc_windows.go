//go:build windows

package sysstats

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func readProcess(pid int) (ProcessReading, bool) {
	if pid <= 0 {
		return ProcessReading{}, false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid)) //nolint:gosec // pid is a positive process id
	if err != nil {
		return ProcessReading{}, false
	}
	defer windows.CloseHandle(h) //nolint:errcheck // nothing to do if closing a query handle fails

	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &created, &exited, &kernel, &user); err != nil {
		return ProcessReading{}, false
	}
	// A process that has exited can still be opened while a handle to it is
	// held elsewhere; its figures are no longer live.
	if exited.HighDateTime != 0 || exited.LowDateTime != 0 {
		return ProcessReading{}, false
	}
	pmc := processMemoryCounters{cb: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	if ok, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.cb)); ok == 0 { //nolint:gosec // G103: audited out-parameter
		return ProcessReading{}, false
	}
	return ProcessReading{
		CPU:   time.Duration(ticks(kernel)+ticks(user)) * 100, //nolint:gosec // CPU time fits int64 nanoseconds for centuries
		RSS:   uint64(pmc.workingSetSize),
		Start: ticks(created),
	}, true
}
