//go:build windows

package sysstats

import (
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	// K32GetProcessMemoryInfo is psapi's GetProcessMemoryInfo, exported by
	// kernel32 itself since Windows 7.
	procGetProcessMemoryInfo = kernel32.NewProc("K32GetProcessMemoryInfo")
)

// memoryStatusEx is MEMORYSTATUSEX.
type memoryStatusEx struct {
	length               uint32
	memoryLoad           uint32
	totalPhys            uint64
	availPhys            uint64
	totalPageFile        uint64
	availPageFile        uint64
	totalVirtual         uint64
	availVirtual         uint64
	availExtendedVirtual uint64
}

// processMemoryCounters is PROCESS_MEMORY_COUNTERS.
type processMemoryCounters struct {
	cb                         uint32
	pageFaultCount             uint32
	peakWorkingSetSize         uintptr
	workingSetSize             uintptr
	quotaPeakPagedPoolUsage    uintptr
	quotaPagedPoolUsage        uintptr
	quotaPeakNonPagedPoolUsage uintptr
	quotaNonPagedPoolUsage     uintptr
	pagefileUsage              uintptr
	peakPagefileUsage          uintptr
}

// ticks is a FILETIME read as a count of 100 ns intervals (a duration, not a
// date, so Filetime.Nanoseconds, which subtracts the 1601 epoch, does not fit).
func ticks(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

// The unsafe.Pointer conversions below are the standard Win32 out-parameter
// pattern for a LazyProc: each pointee is a local that outlives the call.
func readSystem() Reading {
	var r Reading
	self := windows.CurrentProcess()

	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(self, &created, &exited, &kernel, &user); err == nil {
		r.ProcCPU = time.Duration(ticks(kernel)+ticks(user)) * 100 //nolint:gosec // CPU time fits int64 nanoseconds for centuries
		r.ProcCPUOK = true
	}

	var idle, sysKernel, sysUser windows.Filetime
	if ok, _, _ := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),      //nolint:gosec // G103: audited out-parameter
		uintptr(unsafe.Pointer(&sysKernel)), //nolint:gosec // G103: audited out-parameter
		uintptr(unsafe.Pointer(&sysUser)),   //nolint:gosec // G103: audited out-parameter
	); ok != 0 {
		// Kernel time includes idle time.
		total := ticks(sysKernel) + ticks(sysUser)
		if i := ticks(idle); i <= total {
			r.MachBusy, r.MachTotal, r.MachCPUOK = total-i, total, true
		}
	}

	ms := memoryStatusEx{length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	if ok, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms))); ok != 0 && ms.totalPhys > 0 { //nolint:gosec // G103: audited out-parameter
		r.MemTotal = ms.totalPhys
		r.MemUsed = ms.totalPhys - min(ms.availPhys, ms.totalPhys)
		r.MemOK, r.MemScope = true, ScopeMachine
	}

	pmc := processMemoryCounters{cb: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	if ok, _, _ := procGetProcessMemoryInfo.Call(uintptr(self), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.cb)); ok != 0 { //nolint:gosec // G103: audited out-parameter
		r.ProcMem, r.ProcMemOK = uint64(pmc.workingSetSize), true
	}
	return r
}
