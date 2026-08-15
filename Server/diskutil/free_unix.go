//go:build linux || darwin

package diskutil

import "syscall"

// FreeBytes returns the bytes available to unprivileged processes on the
// filesystem containing path.
func FreeBytes(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	// Bavail is what non-root can use; Bsize is the fundamental block size.
	return st.Bavail * uint64(st.Bsize), nil //nolint:gosec // Bsize is a positive block size
}
