package service

import "time"

// AttentionBackupJob is the maintenance step whose runs decide whether a server with no
// backup is waiting for its first run (unknown) or failing (warning).
const AttentionBackupJob = "Backups"

const (
	attentionBackupSignal      = "backup"
	attentionBackupScopeSignal = "backup_scope"
	attentionBackupDiskSignal  = "backup_disk"
)

// BackupArchiveReading is the full-archive side of the backup signals. Scope is the stored backup_scope.
// Newest is the newest stored full archive (zero when none). FailingSince and FailedAt are zero while the
// last run succeeded, and Reason is the last failure.
type BackupArchiveReading struct {
	Scope        string
	Newest       time.Time
	FailingSince time.Time
	FailedAt     time.Time
	Reason       string
}

// BackupDiskReading is the same-disk check. Shared says the backup folder looks to be on a disk the server
// also uses; Acked says the owner confirmed it is not. Dir is the backup folder and With the folder it
// shares a disk with.
type BackupDiskReading struct {
	Dir    string
	With   string
	Shared bool
	Acked  bool
	// Unknown holds why the check could not run; it is empty when it did.
	Unknown string
}
