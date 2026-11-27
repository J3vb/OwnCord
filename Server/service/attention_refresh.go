package service

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

func (s *AttentionService) readBackup(ctx context.Context, r *attentionReadings) {
	r.scheduleErr = errors.New("backup schedule is not available")
	if s.src.BackupSchedule != nil {
		r.schedule, r.scheduleErr = s.src.BackupSchedule(ctx)
		if errors.Is(r.scheduleErr, db.ErrNotFound) {
			r.schedule, r.scheduleErr = "off", nil
		}
	}
	r.lastBackupErr = errors.New("backups are not available")
	if s.src.LastBackup != nil {
		r.lastBackup, r.lastBackupErr = s.src.LastBackup()
	}
	r.archive, r.backupDisk = nil, nil
	if s.src.BackupArchive != nil {
		if a, err := s.src.BackupArchive(ctx); err == nil {
			r.archive = &a
		}
	}
	if s.src.BackupDisk != nil {
		if d, err := s.src.BackupDisk(ctx); err == nil {
			r.backupDisk = &d
		}
	}
}

// RefreshBackup re-evaluates only the backup signal at now so a fresh backup shows at
// once; rate and disk keep their per-minute cadence (an extra sample would skew them).
// No-op before the first full sample. Nil-safe.
func (s *AttentionService) RefreshBackup(ctx context.Context, now time.Time) {
	if s == nil {
		return
	}
	var r attentionReadings
	s.readBackup(ctx, &r)
	s.settled(ctx, func() { s.refreshBackupLocked(r, now) })
}

// refreshBackupLocked swaps in the re-evaluated backup signal. s.mu held.
func (s *AttentionService) refreshBackupLocked(r attentionReadings, now time.Time) {
	i := slices.IndexFunc(s.signals, func(sig AttentionSignal) bool { return sig.ID == attentionBackupSignal })
	if i < 0 {
		return
	}
	s.signals = slices.Delete(s.signals, i, i+1)
	s.evalBackup(r, now)
	last := len(s.signals) - 1
	s.signals = slices.Insert(s.signals[:last], i, s.signals[last])
}
