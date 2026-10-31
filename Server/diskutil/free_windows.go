//go:build windows

package diskutil

import (
	"fmt"
	"syscall"
	"unsafe"
)

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// FreeBytes returns the bytes available to the calling user on the volume
// containing path.
func FreeBytes(path string) (uint64, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var freeToCaller, total, totalFree uint64
	// The unsafe.Pointer conversions below are the standard Win32
	// out-parameter calling pattern for a LazyProc: the pointees are local
	// variables that outlive the syscall, nothing is aliased or reinterpreted.
	r1, _, callErr := procGetDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),             //nolint:gosec // G103: audited — syscall arg, pointee outlives the call
		uintptr(unsafe.Pointer(&freeToCaller)), //nolint:gosec // G103: audited — out-parameter
		uintptr(unsafe.Pointer(&total)),        //nolint:gosec // G103: audited — out-parameter
		uintptr(unsafe.Pointer(&totalFree)),    //nolint:gosec // G103: audited — out-parameter
	)
	if r1 == 0 {
		return 0, callErr
	}
	return freeToCaller, nil
}

// Space returns the bytes available to the calling user and the total size of
// the volume containing path.
func Space(path string) (free, total uint64, err error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, fmt.Errorf("diskutil: path: %w", err)
	}
	var totalFree uint64
	r1, _, callErr := procGetDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(p)),          //nolint:gosec // G103: audited — syscall arg, pointee outlives the call
		uintptr(unsafe.Pointer(&free)),      //nolint:gosec // G103: audited — out-parameter
		uintptr(unsafe.Pointer(&total)),     //nolint:gosec // G103: audited — out-parameter
		uintptr(unsafe.Pointer(&totalFree)), //nolint:gosec // G103: audited — out-parameter
	)
	if r1 == 0 {
		return 0, 0, fmt.Errorf("diskutil: GetDiskFreeSpaceExW: %w", callErr)
	}
	return free, total, nil
}
