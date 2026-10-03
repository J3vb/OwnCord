//go:build windows

package admin

import "os"

// binarySafeFromServerUser reports whether the server's own user cannot write
// path. It is the Windows half of the executed-binary guard: opening for write
// succeeds only when the user has write access.
func binarySafeFromServerUser(path string, _ os.FileInfo) bool {
	f, err := os.OpenFile(path, os.O_WRONLY, 0) //nolint:gosec // G304: path is a config value the guard is judging
	if err != nil {
		return true
	}
	_ = f.Close()
	return false
}
