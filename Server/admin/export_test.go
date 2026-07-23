package admin

// SetBackupBaseDir overrides backupBaseDir so tests can point backup handlers
// at a temp dir. Lives here so it stays out of the production binary.
func SetBackupBaseDir(dir string) { backupBaseDir = dir }
