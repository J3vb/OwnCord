package admin

import "path/filepath"

// backupPaths are the two filesystem locations the backup, restore and archive
// handlers work against. They used to be package globals set at startup by
// SetBackupDir and SetDatabasePath, which two admin APIs built in one process
// (every test) silently shared. Each NewAdminAPI now resolves its own from
// SetupOptions and hands them to the handlers that need them.
type backupPaths struct {
	// dir is the absolute backup directory.
	dir string
	// dbFile is the live SQLite file "Restore backup" stages a copy beside.
	dbFile string
}

// defaultDatabaseFile is the historical database location, used when
// SetupOptions.DatabasePath is empty.
func defaultDatabaseFile() string { return filepath.Join("data", "chatserver.db") }

// ResolveBackupDir is the absolute backup directory for a configured
// backup.dir. Empty keeps the default, data/backups. The admin API resolves
// it once, when it is built, so its handlers do not depend on the process CWD
// later (L14); maintenance and the attention source resolve it per call, and
// nothing changes the working directory after boot.
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

// newBackupPaths resolves the paths a SetupOptions configures. Without a
// DatabasePath, restore keeps targeting the historical data/chatserver.db.
func newBackupPaths(opts SetupOptions) backupPaths {
	paths := backupPaths{dir: ResolveBackupDir(opts.BackupDir), dbFile: opts.DatabasePath}
	if paths.dbFile == "" {
		paths.dbFile = defaultDatabaseFile()
	}
	return paths
}
