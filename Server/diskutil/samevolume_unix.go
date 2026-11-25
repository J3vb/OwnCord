//go:build linux || darwin

package diskutil

import (
	"fmt"
	"syscall"
)

// volumeID is the device number of the filesystem holding path.
func volumeID(path string) (string, error) {
	var st syscall.Stat_t
	if err := syscall.Stat(path, &st); err != nil {
		return "", fmt.Errorf("stat %s: %w", path, err)
	}
	return fmt.Sprintf("%d", st.Dev), nil
}
