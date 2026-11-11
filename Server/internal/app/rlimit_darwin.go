package app

import "golang.org/x/sys/unix"

// maxSoftFileLimit is the highest soft limit setrlimit accepts under hard: on
// macOS kern.maxfilesperproc, since an unlimited soft limit fails with EINVAL.
func maxSoftFileLimit(hard uint64) uint64 {
	perProc, err := unix.SysctlUint32("kern.maxfilesperproc")
	if err != nil {
		return hard
	}
	return min(hard, uint64(perProc))
}
