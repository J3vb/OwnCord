//go:build !linux && !darwin && !windows

package diskutil

// volumeID is unsupported on this platform, so SameVolume reports an unknown answer.
func volumeID(string) (string, error) {
	return "", ErrUnsupported
}
