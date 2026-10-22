package db

import "fmt"

// RestorePending reports whether a staged restore has not finished beside
// dbPath: it returns ErrRestoreInProgress when the marker or the moved-aside
// rollback file exists, and nil otherwise. The offline restore CLI calls it
// under the process lock, so it never overwrites a restore the next boot
// would still apply.
func RestorePending(dbPath string) error {
	if restoreInProgress(dbPath) {
		return fmt.Errorf("restore pending beside %s: %w", dbPath, ErrRestoreInProgress)
	}
	return nil
}
