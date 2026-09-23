package service

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// The per-signal evaluators behind AttentionService.Evaluate (RI-07). Each
// runs under the service's lock and ends in settle.

// attentionLevel commits the first measured level immediately, so a reading
// is never shown as healthy before one is established, and every later new
// level only after it repeats attentionSustain samples (sustain 1 commits
// immediately).
type attentionLevel struct {
	status, pending string
	streak          int
}

func (l *attentionLevel) current() string {
	if l.status == "" {
		return AttentionStatusOK
	}
	return l.status
}

func (l *attentionLevel) settle(raw string, sustain int) string {
	if l.status == "" {
		l.status = raw
	}
	if raw == l.current() {
		l.pending, l.streak = "", 0
		return raw
	}
	if raw != l.pending {
		l.pending, l.streak = raw, 0
	}
	if l.streak++; l.streak >= sustain {
		l.status, l.pending, l.streak = raw, "", 0
	}
	return l.current()
}

func (s *AttentionService) evalDisk(r attentionReadings, now time.Time) {
	sig := AttentionSignal{ID: "disk", Label: "Disk space", ObservedAt: now}
	title := "Disk space is low"
	action := "Free space on the data volume or move the data directory. Uploads are refused below server.min_free_disk_mb and backups may fail."
	if r.diskErr != nil {
		sig.Status, sig.Detail = AttentionStatusUnknown, r.diskErr.Error()
		s.settle(sig, title, action)
		return
	}
	warnAt, critAt := float64(s.thresholds.DiskWarnFreeBytes), float64(s.thresholds.DiskCriticalFreeBytes)
	free, cur := float64(r.diskFree), s.disk.current()
	raw := AttentionStatusOK
	switch {
	case critAt > 0 && (free < critAt || cur == AttentionStatusCritical && free < critAt*attentionDiskClearMargin):
		raw = AttentionStatusCritical
	case warnAt > 0 && (free < warnAt || cur != AttentionStatusOK && free < warnAt*attentionDiskClearMargin):
		raw = AttentionStatusWarning
	}
	sig.Status = s.disk.settle(raw, attentionSustain)
	sig.Value = fmt.Sprintf("%s free", attentionMB(r.diskFree))
	sig.Threshold = fmt.Sprintf("warn below %s, critical below %s", attentionMB(s.thresholds.DiskWarnFreeBytes), attentionMB(s.thresholds.DiskCriticalFreeBytes))
	s.settle(sig, title, action)
}

func attentionMB(b uint64) string { return fmt.Sprintf("%.0f MB", float64(b)/(1<<20)) }

// attentionRate turns a cumulative counter into a per-minute rate with a
// learned baseline and a hysteresis band.
type attentionRate struct {
	level    attentionLevel
	last     float64
	lastAt   time.Time
	primed   bool
	baseline float64
	samples  int
}

type rateSpec struct {
	id, label, unit, title, action string
	floor                          float64
	dead                           bool // the producer itself stopped: critical
	quietWarmup                    bool // bursts right after a restart are expected: warm-up raises nothing
}

func (s *AttentionService) evalRate(st *attentionRate, total *float64, now time.Time, spec rateSpec) {
	sig := AttentionSignal{ID: spec.id, Label: spec.label, ObservedAt: now}
	if total == nil {
		sig.Status, sig.Detail = AttentionStatusUnknown, "not measured on this server"
		s.settle(sig, spec.title, spec.action)
		return
	}
	if !st.primed || !now.After(st.lastAt) || *total < st.last {
		st.last, st.lastAt, st.primed = *total, now, true
		sig.Status, sig.Detail = AttentionStatusUnknown, "collecting the first interval"
		s.settle(sig, spec.title, spec.action)
		return
	}
	rate := (*total - st.last) / now.Sub(st.lastAt).Minutes()
	st.last, st.lastAt = *total, now
	// The first measured interval holds the post-restart resume burst and is
	// never learned. During warm-up a quietWarmup signal learns every later
	// sample and raises nothing; any other signal learns only samples at or
	// below its floor and raises at the floor, so pressure present at boot is
	// raised rather than learned. After warm-up only healthy samples are
	// learned, so sustained pressure never becomes the normal. A stopped
	// dispatch loop commits as soon as it is seen; any other rate level
	// starts healthy and needs attentionSustain samples to change.
	first := st.level.status == ""
	if first {
		st.level.status = AttentionStatusOK
	}
	warm := st.samples >= attentionBaselineWarmup
	threshold := spec.floor
	if warm {
		threshold = max(threshold, attentionBaselineFactor*st.baseline)
	}
	cur := st.level.current()
	raw := AttentionStatusOK
	switch {
	case spec.dead:
		raw = AttentionStatusCritical
	case (warm || !spec.quietWarmup) && (rate >= threshold || cur != AttentionStatusOK && rate >= threshold*attentionRateClearRatio):
		raw = AttentionStatusWarning
	}
	sustain := attentionSustain
	if spec.dead {
		sustain = 1
	}
	sig.Status = st.level.settle(raw, sustain)
	st.learn(rate, first, warm, sig.Status == AttentionStatusOK && raw == AttentionStatusOK, spec)
	sig.Value = fmt.Sprintf("%.1f %s", rate, spec.unit)
	sig.Threshold = fmt.Sprintf("raise at %.1f %s", threshold, spec.unit)
	if warm {
		sig.Detail = fmt.Sprintf("baseline %.1f %s", st.baseline, spec.unit)
	} else {
		sig.Detail = fmt.Sprintf("learning the baseline (%d of %d samples); raising at the floor until then", st.samples, attentionBaselineWarmup)
		if spec.quietWarmup {
			sig.Detail = fmt.Sprintf("learning the baseline (%d of %d samples); warnings start after it", st.samples, attentionBaselineWarmup)
		}
	}
	if spec.dead {
		sig.Detail = "the message dispatch loop has stopped"
	}
	s.settle(sig, spec.title, spec.action)
}

// learn folds rate into the baseline under evalRate's learning rules; healthy
// is whether this sample both settled and measured ok.
func (st *attentionRate) learn(rate float64, first, warm, healthy bool, spec rateSpec) {
	learn := false
	switch {
	case first:
	case warm:
		learn = healthy
	case spec.quietWarmup:
		learn = true
	default:
		learn = rate <= spec.floor
	}
	if !learn {
		return
	}
	if st.samples == 0 {
		st.baseline = rate
	} else {
		st.baseline += attentionBaselineAlpha * (rate - st.baseline)
	}
	st.samples++
}

// BackupScheduleInterval is the scheduled-backup interval for a
// backup_schedule setting value; "off" or anything unrecognised is 0,
// scheduling disabled.
func BackupScheduleInterval(schedule string) time.Duration {
	switch strings.ToLower(strings.TrimSpace(schedule)) {
	case "daily":
		return 24 * time.Hour
	case "weekly":
		return 7 * 24 * time.Hour
	}
	return 0
}

func (s *AttentionService) evalBackup(r attentionReadings, now time.Time) {
	sig := AttentionSignal{ID: "backup", Label: "Last successful backup", ObservedAt: now}
	title := "Backups are out of date"
	action := "Open Backups and take a backup now; if scheduled backups keep failing, search Server Logs for \"backup maintenance failed\"."
	if r.scheduleErr != nil || r.lastBackupErr != nil {
		sig.Status, sig.Detail = AttentionStatusUnknown, errors.Join(r.scheduleErr, r.lastBackupErr).Error()
		s.settle(sig, title, action)
		return
	}
	interval := BackupScheduleInterval(r.schedule)
	if !r.lastBackup.IsZero() {
		sig.Value = r.lastBackup.UTC().Format("2006-01-02 15:04 UTC")
	}
	switch {
	case interval == 0 && r.lastBackup.IsZero():
		sig.Status, sig.Detail = AttentionStatusWarning, "no backup exists and scheduled backups are off"
	case interval == 0:
		sig.Status, sig.Detail = AttentionStatusOK, "scheduled backups are off"
	case r.lastBackup.IsZero():
		sig.Status, sig.Detail = AttentionStatusWarning, "no successful backup yet"
		if j := s.job(AttentionBackupJob); j == nil || j.lastRun.IsZero() {
			sig.Status, sig.Detail = AttentionStatusUnknown, "waiting for the first scheduled backup run"
		}
	default:
		age := now.Sub(r.lastBackup)
		sig.Status = AttentionStatusOK
		if age > 3*interval {
			sig.Status = AttentionStatusCritical
		} else if age > interval*3/2 {
			sig.Status = AttentionStatusWarning
		}
		sig.Detail = fmt.Sprintf("%s old", age.Truncate(time.Minute))
	}
	if interval > 0 {
		sig.Threshold = fmt.Sprintf("%s schedule: warn after %s", r.schedule, interval*3/2)
	}
	s.settle(sig, title, action)
}

func (s *AttentionService) evalJobs(now time.Time) {
	for _, j := range s.jobs {
		sig := AttentionSignal{ID: "job:" + j.label, Label: "Maintenance: " + j.label, ObservedAt: now}
		title := "Maintenance job failing: " + j.label
		action := "Search Server Logs for the job's error"
		if j.logHint != "" {
			action += fmt.Sprintf(" (%q)", j.logHint)
		}
		action += "; it retries on every 15-minute maintenance pass."
		switch {
		case j.lastRun.IsZero():
			sig.Status, sig.Detail = AttentionStatusUnknown, "no completed run since the server started"
		case j.consecutiveFailures >= attentionJobFailures:
			sig.Status = AttentionStatusWarning
			sig.Value = fmt.Sprintf("%d consecutive failed runs", j.consecutiveFailures)
			sig.Detail = j.lastErr
		default:
			sig.Status = AttentionStatusOK
			sig.Value = "last run " + j.lastRun.UTC().Format("2006-01-02 15:04 UTC")
			if j.consecutiveFailures > 0 {
				sig.Detail = "last run failed: " + j.lastErr
			}
		}
		if !j.lastSuccess.IsZero() && sig.Status == AttentionStatusWarning {
			sig.Detail += "; last success " + j.lastSuccess.UTC().Format("2006-01-02 15:04 UTC")
		}
		s.settle(sig, title, action)
	}
}
