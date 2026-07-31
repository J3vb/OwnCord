package admin

// SetBackupBaseDir overrides backupBaseDir so tests can point backup handlers
// at a temp dir. Lives here so it stays out of the production binary.
func SetBackupBaseDir(dir string) { backupBaseDir = dir }

// StubRestart replaces the process-restart hook for the duration of a test and
// returns a func reporting whether a restart was requested. Without this the
// restore handler would respawn and os.Exit the test binary.
func StubRestart() (restarted func() bool, restore func()) {
	prev := restartSelf
	called := false
	restartSelf = func(string) { called = true }
	return func() bool { return called }, func() { restartSelf = prev }
}
