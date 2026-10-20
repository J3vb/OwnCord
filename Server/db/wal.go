package db

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// walFilePath is the write-ahead log SQLite keeps beside a database file,
// parsed the same way as the retry-floor sidecar. SQLite follows a symlinked
// database to its target and keeps the WAL there, so this does too. A path
// that names no file gives "", which WALBytes reports as 0.
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

// WALBytes reports the size of the write-ahead log file. It is 0 with a nil
// error for an in-memory database (no WAL file) and when the file does not
// exist (a fresh or just-checkpointed database); any other stat failure is
// returned wrapped. One stat per call, safe for a per-scrape read.
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
