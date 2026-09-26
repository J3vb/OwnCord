//go:build windows

package db

import "golang.org/x/sys/windows"

func replaceMessageDeliveryFloor(temporary, destination string) error {
	src, err := windows.UTF16PtrFromString(temporary)
	if err != nil {
		return err
	}
	dst, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	// Opening and syncing a directory is not supported by Windows. Request a
	// write-through replacement after the temporary file itself was flushed.
	return windows.MoveFileEx(src, dst, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
