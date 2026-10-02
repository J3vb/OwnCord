package app

import "golang.org/x/sys/unix"

// maxSoftFileLimit is the highest soft limit setrlimit accepts under hard. On
// macOS that is kern.maxfilesperproc, not the hard limit: the default hard
// limit is unlimited, and asking for an unlimited soft limit fails with EINVAL
// (the Go runtime applies the same clamp at init).
func maxSoftFileLimit(hard uint64) uint64 {
	perProc, err := unix.SysctlUint32("kern.maxfilesperproc")
	if err != nil {
		return hard
	}
	return min(hard, uint64(perProc))
}
