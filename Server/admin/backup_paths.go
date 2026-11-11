package admin

import "path/filepath"

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
