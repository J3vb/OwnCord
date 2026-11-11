package db

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// walFilePath is the write-ahead log beside a database file. SQLite keeps the WAL
// beside a symlink's target, so this does too; no path gives "" (WALBytes reports 0).
func walFilePath(path string) string {
	p, err := dbFilePath(path)
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	return p + "-wal"
}

// WALBytes reports the size of the write-ahead log file: 0 with a nil error for an
// in-memory database or a missing file; any other stat failure is returned wrapped.
// One stat per call, safe for a per-scrape read.
func (d *DB) WALBytes() (int64, error) {
	if d.walPath == "" {
		return 0, nil
	}
	fi, err := os.Stat(d.walPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("stat wal file: %w", err)
	}
	return fi.Size(), nil
}
