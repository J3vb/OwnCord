package admin

import (
	"os"
	"path/filepath"
)

// backupPaths are the filesystem locations the backup, restore and archive handlers work against, resolved
// per NewAdminAPI from SetupOptions: process-wide globals were silently shared by two admin APIs in one
// process (every test).
type backupPaths struct {
	dir string
	// dbFile is the live SQLite file "Restore backup" stages a copy beside.
	dbFile string
}

// defaultDatabaseFile is used when SetupOptions.DatabasePath is empty.
func defaultDatabaseFile() string { return filepath.Join("data", "chatserver.db") }

// ResolveBackupDir is the absolute directory for a configured backup.dir (empty = data/backups). The admin
// API resolves it once at build so handlers do not depend on the CWD later; nothing changes the working
// directory after boot.
func ResolveBackupDir(dir string) string {
	if dir == "" {
		dir = filepath.Join("data", "backups")
	}
	return absOrRaw(dir)
}

func absOrRaw(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

func newBackupPaths(opts SetupOptions) backupPaths {
	paths := backupPaths{dir: ResolveBackupDir(opts.BackupDir), dbFile: opts.DatabasePath}
	if paths.dbFile == "" {
		paths.dbFile = defaultDatabaseFile()
	}
	return paths
}

// liveDatabaseSuffixes are the SQLite sidecars that belong to the live database file.
var liveDatabaseSuffixes = []string{"", "-wal", "-shm", "-journal"}

// isLiveDatabaseFile reports whether path is the live database or one of its sidecars. It compares file
// identity first, so a symlink or a differently spelled path still matches, and falls back to the cleaned
// absolute path when either side cannot be stat'ed.
func isLiveDatabaseFile(path, dbFile string) bool {
	if path == "" {
		return false
	}
	if dbFile == "" {
		dbFile = defaultDatabaseFile()
	}
	candidate, candErr := os.Stat(path)
	for _, suffix := range liveDatabaseSuffixes {
		live := dbFile + suffix
		if candErr == nil {
			if liveInfo, err := os.Stat(live); err == nil && os.SameFile(candidate, liveInfo) {
				return true
			}
		}
		if absOrRaw(filepath.Clean(path)) == absOrRaw(filepath.Clean(live)) {
			return true
		}
	}
	return false
}

// sameDirectory reports whether a and b name the same directory.
func sameDirectory(a, b string) bool {
	ia, errA := os.Stat(a)
	ib, errB := os.Stat(b)
	if errA == nil && errB == nil {
		return os.SameFile(ia, ib)
	}
	return absOrRaw(filepath.Clean(a)) == absOrRaw(filepath.Clean(b))
}
