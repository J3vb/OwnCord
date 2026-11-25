package service

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSettings_BackupScopeAcceptsOnlyDatabaseOrEverything(t *testing.T) {
	t.Parallel()
	svc, _ := newSettingsService(t)
	ctx := context.Background()
	for _, tc := range []struct {
		value, want string
	}{
		{"database", "database"},
		{" Everything ", "everything"},
		{"EVERYTHING", "everything"},
	} {
		got, err := svc.Patch(ctx, 1, map[string]string{BackupScopeKey: tc.value})
		mustDo(t, "Patch "+tc.value, err)
		if got[BackupScopeKey] != tc.want {
			t.Errorf("backup_scope after %q = %q, want %q", tc.value, got[BackupScopeKey], tc.want)
		}
	}
	// "unset" is the migration's own value for an owner who has not chosen; it cannot be written back.
	for _, bad := range []string{"unset", "", "all", "db", "full"} {
		_, err := svc.Patch(ctx, 1, map[string]string{BackupScopeKey: bad})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("Patch backup_scope=%q err = %v, want ErrBadRequest", bad, err)
		}
	}
	if got, _ := svc.Setting(ctx, BackupScopeKey); got != "everything" {
		t.Errorf("a refused value changed backup_scope to %q", got)
	}
}

func TestSettings_BackupDiskAckValidation(t *testing.T) {
	t.Parallel()
	svc, _ := newSettingsService(t)
	ctx := context.Background()
	got, err := svc.Patch(ctx, 1, map[string]string{BackupDiskAckKey: "  /mnt/backups  "})
	mustDo(t, "Patch ack", err)
	if got[BackupDiskAckKey] != "/mnt/backups" {
		t.Errorf("backup_disk_ack = %q, want the trimmed path", got[BackupDiskAckKey])
	}
	// Blank clears it.
	got, err = svc.Patch(ctx, 1, map[string]string{BackupDiskAckKey: ""})
	mustDo(t, "Patch clear", err)
	if got[BackupDiskAckKey] != "" {
		t.Errorf("backup_disk_ack after clearing = %q", got[BackupDiskAckKey])
	}
	for name, bad := range map[string]string{
		"control character": "/mnt/back\x00ups",
		"newline":           "/mnt/a\nb",
		"too long":          strings.Repeat("a", maxBackupDiskAckLen+1),
	} {
		if _, err := svc.Patch(ctx, 1, map[string]string{BackupDiskAckKey: bad}); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s: err = %v, want ErrBadRequest", name, err)
		}
	}
}

func TestSettings_BackupKeysAreOwnerOnly(t *testing.T) {
	t.Parallel()
	for _, key := range []string{BackupScopeKey, BackupDiskAckKey} {
		if !IsOwnerOnlySettingKey(key) {
			t.Errorf("%s is not owner-only", key)
		}
	}
}

func TestBackupScope_ReadsStoredValues(t *testing.T) {
	t.Parallel()
	for stored, want := range map[string]string{
		"database": BackupScopeDatabase, "everything": BackupScopeEverything, " Everything ": BackupScopeEverything,
		"unset": BackupScopeUnset, "": BackupScopeUnset, "junk": BackupScopeUnset,
	} {
		if got := BackupScope(stored); got != want {
			t.Errorf("BackupScope(%q) = %q, want %q", stored, got, want)
		}
	}
}
