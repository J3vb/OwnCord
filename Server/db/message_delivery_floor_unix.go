//go:build !windows

package db

import (
	"os"
	"path/filepath"
)

func replaceMessageDeliveryFloor(temporary, destination string) error {
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	// Persist the rename before the restore is allowed to replace the DB.
	dir, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}
