//go:build linux || darwin

package diskutil

import (
	"fmt"
	"strconv"
	"syscall"
)

// volumeID is the device number of the filesystem holding path.
func volumeID(path string) (string, error) {
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return "", fmt.Errorf("stat %s: %w", path, err)
	}
	return strconv.FormatUint(uint64(st.Dev), 10), nil //nolint:gosec // G115: a device number is never negative
}
