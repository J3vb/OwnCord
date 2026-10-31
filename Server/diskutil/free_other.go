//go:build !linux && !darwin && !windows

package diskutil

// FreeBytes is unsupported on this platform.
func FreeBytes(string) (uint64, error) {
	return 0, ErrUnsupported
}

// Space is unsupported on this platform.
func Space(string) (free, total uint64, err error) {
	return 0, 0, ErrUnsupported
}
