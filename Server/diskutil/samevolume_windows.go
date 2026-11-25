//go:build windows

package diskutil

import (
	"fmt"
	"strconv"
	"syscall"
	"unsafe"
)

var (
	procGetVolumePathName   = kernel32.NewProc("GetVolumePathNameW")
	procGetVolumeInformaton = kernel32.NewProc("GetVolumeInformationW")
)

// volumeID is the serial number of the volume holding path, so a drive letter, a mounted folder and a UNC
// share on one volume agree. A missing path reports an error that matches fs.ErrNotExist.
func volumeID(path string) (string, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", fmt.Errorf("volume path: %w", err)
	}
	root := make([]uint16, syscall.MAX_PATH+1)
	// The unsafe.Pointer conversions are the standard Win32 calling pattern: the buffers outlive the call.
	r1, _, callErr := procGetVolumePathName.Call(
		uintptr(unsafe.Pointer(p)),        //nolint:gosec // G103: audited — syscall arg, pointee outlives the call
		uintptr(unsafe.Pointer(&root[0])), //nolint:gosec // G103: audited — out buffer
		uintptr(len(root)),
	)
	if r1 == 0 {
		return "", fmt.Errorf("GetVolumePathNameW: %w", callErr)
	}
	var serial uint32
	r1, _, callErr = procGetVolumeInformaton.Call(
		uintptr(unsafe.Pointer(&root[0])), //nolint:gosec // G103: audited — syscall arg, pointee outlives the call
		0, 0,
		uintptr(unsafe.Pointer(&serial)), //nolint:gosec // G103: audited — out-parameter
		0, 0, 0, 0,
	)
	if r1 == 0 {
		return "", fmt.Errorf("GetVolumeInformationW: %w", callErr)
	}
	return strconv.FormatUint(uint64(serial), 16), nil
}
