package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"github.com/J3vb/OwnCord/Server/db"
)

// BackupScopeKey is what automatic backups cover: "database", "everything", or "unset" until the owner picks
// (see BackupScope). A PATCH accepts only the first two.
const BackupScopeKey = "backup_scope"

// Backup scope values.
const (
	BackupScopeDatabase   = "database"
	BackupScopeEverything = "everything"
	BackupScopeUnset      = "unset"
)

// BackupScope reads a stored backup_scope: a blank, missing or damaged row is "unset", which backs up like
// "database" and asks the owner to choose.
func BackupScope(stored string) string {
	switch v := strings.ToLower(strings.TrimSpace(stored)); v {
	case BackupScopeDatabase, BackupScopeEverything:
		return v
	}
	return BackupScopeUnset
}

// BackupDiskAckKey holds the backup folder the owner confirmed is on another disk than the server. It counts
// only while backup.dir is still that folder, so moving the folder asks again.
const BackupDiskAckKey = "backup_disk_ack"

// maxBackupDiskAckLen bounds the stored path.
const maxBackupDiskAckLen = 4096

// normalizeBackupSetting validates a PATCH value for backup_scope (database or everything; "unset" is the
// migration's own and cannot be written back) or backup_disk_ack (a folder path, or blank to clear it).
func normalizeBackupSetting(key, value string) (string, error) {
	if key == BackupScopeKey {
		scope := strings.ToLower(strings.TrimSpace(value))
		if scope != BackupScopeDatabase && scope != BackupScopeEverything {
			return "", fmt.Errorf("%s: must be one of database, everything", key)
		}
		return scope, nil
	}
	ack := strings.TrimSpace(value)
	if len(ack) > maxBackupDiskAckLen || strings.ContainsFunc(ack, unicode.IsControl) {
		return "", fmt.Errorf("%s: must be a folder path of at most %d characters", key, maxBackupDiskAckLen)
	}
	return ack, nil
}

// SettingOr returns one setting's value, or fallback when its row does not exist; any other read error is
// returned.
func (s *SettingsService) SettingOr(ctx context.Context, key, fallback string) (string, error) {
	v, err := s.st.GetSetting(ctx, key)
	if errors.Is(err, db.ErrNotFound) {
		return fallback, nil
	}
	if err != nil {
		return "", fmt.Errorf("SettingOr %s: %w", key, err)
	}
	return v, nil
}
