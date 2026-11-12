package db

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"github.com/J3vb/OwnCord/Server/diskutil"
)

// ErrBackupNoSpace is returned by BackupToSafe when the backup volume has too little
// free space for the copy plus the configured reserve. No file is created.
var ErrBackupNoSpace = errors.New("not enough free disk space for a backup")

// backupSpace is the reserve and free-space reader BackupToSafe checks
// against.
type backupSpace struct {
	reserve uint64
	free    func(dir string) (uint64, error)
}

// SetBackupDiskReserve sets the free space (bytes, server.min_free_disk_mb) every
// backup must leave on the backup volume; 0 checks only that the copy fits. Call it
// once after Open.
func (d *DB) SetBackupDiskReserve(reserve uint64) {
	d.backupSpace.Store(&backupSpace{reserve: reserve, free: diskutil.FreeBytes})
}

// SetBackupFreeBytesForTest replaces BackupToSafe's free-space reader. Tests only.
func (d *DB) SetBackupFreeBytesForTest(reserve uint64, free func(dir string) (uint64, error)) {
	d.backupSpace.Store(&backupSpace{reserve: reserve, free: free})
}

// checkBackupSpace refuses a backup into dir when the volume's free space is
// below the database file plus its WAL plus the reserve: VACUUM INTO writes a
// copy about that size, and a copy that fills the disk also fails the live
// database's own writes. A volume whose free space cannot be read is not
// treated as full. An in-memory database has no file to copy.
func (d *DB) checkBackupSpace(dir string) error {
	if d.walPath == "" {
		return nil
	}
	space := d.backupSpace.Load()
	if space == nil {
		space = &backupSpace{free: diskutil.FreeBytes}
	}
	free, err := space.free(dir)
	if err != nil {
		return nil //nolint:nilerr // unknown free space is not "full"; the copy surfaces a real failure
	}
	dbBytes, err := fileBytes(strings.TrimSuffix(d.walPath, "-wal"))
	if err != nil {
		return fmt.Errorf("backup space check: %w", err)
	}
	walBytes, err := d.WALBytes()
	if err != nil {
		return fmt.Errorf("backup space check: %w", err)
	}
	need := dbBytes + uint64(max(walBytes, 0)) + space.reserve
	if free >= need {
		return nil
	}
	return fmt.Errorf("%w: it needs about %d MB (the database and its write-ahead log, plus %d MB kept free by server.min_free_disk_mb) and %d MB is free",
		ErrBackupNoSpace, mibUp(need), mibUp(space.reserve), free>>20)
}

func fileBytes(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("stat database file: %w", err)
	}
	return uint64(max(fi.Size(), 0)), nil
}

// mibUp is n bytes in MiB, rounded up, so a refused need never prints as
// equal to or below the free figure.
func mibUp(n uint64) uint64 {
	return (n + 1<<20 - 1) >> 20
}
