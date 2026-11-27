package db

import (
	"os"
	"runtime"
	"strings"
)

// createOwnerOnlyIfMissing creates an empty database file at path with mode 0600
// when none exists, so SQLite opens it instead of creating it with the process
// default; SQLite gives the -wal and -shm files the main file's mode. An existing
// file keeps its mode, a "file:" URI is left to SQLite, and Windows is unchanged.
// A failure is left for SQLite's own open to report, as before.
func createOwnerOnlyIfMissing(path string) {
	if runtime.GOOS == "windows" || strings.HasPrefix(path, "file:") || strings.Contains(path, "?") {
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: the configured database path
	if err != nil {
		return
	}
	_ = f.Close()
}
