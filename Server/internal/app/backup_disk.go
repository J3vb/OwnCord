package app

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/diskutil"
	"github.com/J3vb/OwnCord/Server/service"
)

// backupArchiveReading is what the attention panel needs about the full archive: the stored backup_scope, the
// newest stored archive and the last failed run.
func backupArchiveReading(ctx context.Context, cfg *config.Config, settings *service.SettingsService) (service.BackupArchiveReading, error) {
	stored, err := settings.SettingOr(ctx, service.BackupScopeKey, "")
	if err != nil {
		return service.BackupArchiveReading{}, fmt.Errorf("reading backup_scope: %w", err)
	}
	st, err := admin.ScheduledArchiveStatus(admin.ResolveBackupDir(cfg.Backup.Dir))
	if err != nil {
		return service.BackupArchiveReading{}, fmt.Errorf("reading stored archives: %w", err)
	}
	return service.BackupArchiveReading{
		Scope:        service.BackupScope(stored),
		Newest:       st.Newest,
		FailingSince: st.FailingSince,
		FailedAt:     st.FailedAt,
		Reason:       st.Reason,
	}, nil
}

// backupDiskReading compares the backup folder with the data folder, the database file's folder and the
// uploads folder. A match is "may share a disk", never proof: Docker overlays, btrfs and ZFS subvolumes and
// shared mounts can fool the comparison either way. same is diskutil.SameVolume, a seam for tests.
func backupDiskReading(ctx context.Context, cfg *config.Config, settings *service.SettingsService, same func(a, b string) (bool, error)) (service.BackupDiskReading, error) {
	dir := admin.ResolveBackupDir(cfg.Backup.Dir)
	out := service.BackupDiskReading{Dir: dir}
	others := []string{cfg.Server.DataDir, filepath.Dir(cfg.Database.Path), cfg.Upload.StorageDir}
	var firstErr error
	for _, other := range others {
		if other == "" || other == "." {
			continue
		}
		abs, err := filepath.Abs(other)
		if err != nil {
			continue
		}
		shared, err := same(dir, abs)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if shared {
			out.Shared, out.With = true, abs
			break
		}
	}
	if !out.Shared && firstErr != nil {
		out.Unknown = firstErr.Error()
	}
	ack, err := settings.SettingOr(ctx, service.BackupDiskAckKey, "")
	if err != nil {
		return out, fmt.Errorf("reading backup_disk_ack: %w", err)
	}
	out.Acked = ack != "" && ack == dir
	return out, nil
}

// sameVolume is the probe the server uses.
var sameVolume = diskutil.SameVolume
