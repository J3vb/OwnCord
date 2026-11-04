package service

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// readBackup fills the backup schedule and newest-backup readings.
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
}

// RefreshBackup re-reads the backup schedule and the newest backup and
// re-evaluates only the backup signal at now, so a backup just taken shows on the
// panel at once instead of after the next minute's sample. The rate and disk
// signals keep their per-minute cadence: an extra sample would skew their
// rates and sustain counts. Before the first full sample there is no signal
// to replace and it does nothing. Nil-safe for partial wirings.
func (s *AttentionService) RefreshBackup(ctx context.Context, now time.Time) {
	if s == nil {
		return
	}
	var r attentionReadings
	s.readBackup(ctx, &r)
	s.mu.Lock()
	defer s.mu.Unlock()
	i := slices.IndexFunc(s.signals, func(sig AttentionSignal) bool { return sig.ID == attentionBackupSignal })
	if i < 0 {
		return
	}
	s.signals = slices.Delete(s.signals, i, i+1)
	s.evalBackup(r, now)
	last := len(s.signals) - 1
	s.signals = slices.Insert(s.signals[:last], i, s.signals[last])
}
