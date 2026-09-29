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
	var floors []string
	if warnAt > critAt {
		floors = append(floors, "warn below "+attentionMB(s.thresholds.DiskWarnFreeBytes))
	}
	if critAt > 0 {
		floors = append(floors, "critical below "+attentionMB(s.thresholds.DiskCriticalFreeBytes))
	}
	sig.Value = fmt.Sprintf("%s free", attentionMB(r.diskFree))
	if len(floors) == 0 {
		sig.Status, sig.Detail = AttentionStatusUnknown, "not checked: attention.disk_warn_free_mb and server.min_free_disk_mb are both 0"
		s.settle(sig, title, action)
		return
	}
	free, cur := float64(r.diskFree), s.disk.current()
	raw := AttentionStatusOK
	switch {
	case critAt > 0 && (free < critAt || cur == AttentionStatusCritical && free < critAt*attentionDiskClearMargin):
		raw = AttentionStatusCritical
	case warnAt > 0 && (free < warnAt || cur != AttentionStatusOK && free < warnAt*attentionDiskClearMargin):
		raw = AttentionStatusWarning
	}
	sig.Status = s.disk.settle(raw, attentionSustain)
	sig.Threshold = strings.Join(floors, ", ")
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

// evalVoice reports the LiveKit voice path's health and restart state
// (SRE-04). A managed companion that is not running — a crash loop that gave
// up, or a start that never succeeded — is the failure class users report
// most, so it warns, and a companion whose restarts exhausted the backoff is
// critical. An externally managed LiveKit is health-probed and warns when it
// does not answer; an unconfigured voice path is unknown, never healthy.
func (s *AttentionService) evalVoice(r attentionReadings, now time.Time) {
	sig := AttentionSignal{ID: "voice", Label: "Voice (LiveKit)", ObservedAt: now}
	title := "Voice is unavailable"
	action := "Check Server Logs for \"livekit companion output\" entries (component=livekit; the managed LiveKit's own line is in their line attribute). If it gave up, fix its config or binary and restart the server."
	if r.voice == nil {
		sig.Status, sig.Detail = AttentionStatusUnknown, "voice health is not measured on this server"
		s.settle(sig, title, action)
		return
	}
	v := *r.voice
	if !v.Managed {
		// External LiveKit: a probe answer warns when unreachable; no probe
		// (unconfigured) is unknown. Its output never reaches Server Logs.
		action = "Confirm the external LiveKit is reachable at voice.livekit_url. Its output is not in Server Logs or the support bundle: read it where it runs, e.g. docker compose logs livekit."
		if v.Reachable == nil {
			sig.Status, sig.Detail = AttentionStatusUnknown, "LiveKit is not configured"
			s.settle(sig, title, action)
			return
		}
		raw := AttentionStatusOK
		if !*v.Reachable {
			raw = AttentionStatusWarning
		}
		sig.Status = s.voice.settle(raw, attentionSustain)
		if sig.Status == AttentionStatusWarning {
			sig.Value = "unreachable"
			sig.Detail = "the external LiveKit server did not answer its health probe; check it at voice.livekit_url"
		} else {
			sig.Value = "external, reachable"
		}
		s.settle(sig, title, action)
		return
	}
	// Hysteresis like the disk signal: the first measured level commits at
	// once, every later change needs attentionSustain samples, so one
	// noisy minute neither raises nor clears.
	raw := AttentionStatusOK
	switch {
	case v.GaveUp:
		raw = AttentionStatusCritical
	case !v.Running:
		raw = AttentionStatusWarning
	}
	sig.Status = s.voice.settle(raw, attentionSustain)
	switch sig.Status {
	case AttentionStatusCritical:
		sig.Value = "gave up"
		sig.Detail = fmt.Sprintf("the companion exited %d time(s) and the supervisor stopped restarting it", v.Restarts)
	case AttentionStatusWarning:
		sig.Value = "not running"
		sig.Detail = "the supervised LiveKit process is not running; voice joins are refused"
	default:
		sig.Value = "running"
		if v.Restarts > 0 {
			sig.Detail = fmt.Sprintf("restarted %d time(s) after an unexpected exit", v.Restarts)
		}
	}
	s.settle(sig, title, action)
}

// evalCertificate reports how long the served TLS certificate has left.
// Nothing here renews a self-signed or manual certificate, and an ACME
// renewal that keeps failing is silent until handshakes fail, so the panel
// warns ahead of the date. TLS off (a reverse proxy serves the certificate)
// and ACME before its first handshake have nothing to read: unknown.
func (s *AttentionService) evalCertificate(r attentionReadings, now time.Time) {
	sig := AttentionSignal{ID: "certificate", Label: "TLS certificate", ObservedAt: now}
	title := "The TLS certificate expires soon"
	action := "Replace the certificate before it expires (docs/deployment.md, \"Rotating the self-signed certificate\"; a manual certificate is reloaded on restart), then publish the new fingerprint from the Dashboard so members can check it."
	if r.certMode == "acme" {
		action = "Let's Encrypt renews 30 days before expiry, so renewal is failing: check that port 80 reaches this server from the internet and search Server Logs for \"TLS certificate issuance failed\". Members see the renewed certificate's fingerprint on the Dashboard once it is served."
	}
	switch {
	case !r.certMeasured:
		sig.Status, sig.Detail = AttentionStatusUnknown, "the certificate is not measured on this server"
	case r.certMode == "off":
		sig.Status, sig.Detail = AttentionStatusUnknown, "TLS is off here: your reverse proxy serves the certificate, so check its renewal there"
	case r.certNotAfter.IsZero():
		sig.Status, sig.Detail = AttentionStatusUnknown, "no certificate served yet; it is read on the first HTTPS connection"
	default:
		left := r.certNotAfter.Sub(now)
		sig.Status = AttentionStatusOK
		switch {
		case left < attentionCertCritical:
			sig.Status = AttentionStatusCritical
		case left < attentionCertWarn:
			sig.Status = AttentionStatusWarning
		}
		date := r.certNotAfter.UTC().Format("2006-01-02")
		if left <= 0 {
			sig.Value = "expired " + date
		} else {
			sig.Value = fmt.Sprintf("expires %s (%d days)", date, int(left.Hours()/24))
		}
		sig.Threshold = fmt.Sprintf("warn under %d days, critical under %d", int(attentionCertWarn.Hours()/24), int(attentionCertCritical.Hours()/24))
	}
	s.settle(sig, title, action)
}

// evalBootStatus reports how the previous run ended (SRE-08): a marker left
// behind by a kill, a crash or a hardware exit is a warning, a clean shutdown
// is ok, and a first start with no marker is unknown.
func (s *AttentionService) evalBootStatus(now time.Time) {
	sig := AttentionSignal{ID: "last_exit", Label: "Last server exit", ObservedAt: now}
	title := "The server did not shut down cleanly"
	action := "Server Logs start empty after a restart, so check the host's service or container log (journald, docker logs, or the Windows Event Log): this run's startup line \"the previous run did not shut down cleanly\" names previous_started_at and last_panic_at, and the lines after that start time show the panic, hardware-fault exit or out-of-memory kill. A kill -9 or a crash is not a graceful shutdown."
	switch {
	case !s.boot.Recorded:
		sig.Status, sig.Detail = AttentionStatusUnknown, "no record from a previous run"
	case s.boot.Unclean:
		sig.Status = AttentionStatusWarning
		if !s.boot.StartedAt.IsZero() {
			sig.Value = "run started " + s.boot.StartedAt.UTC().Format("2006-01-02 15:04 UTC") + " did not shut down cleanly"
		} else {
			sig.Value = "previous run ended without a clean shutdown"
		}
		if !s.boot.LastPanicAt.IsZero() {
			sig.Detail = "last panic recovered " + s.boot.LastPanicAt.UTC().Format("2006-01-02 15:04 UTC")
		}
	default:
		sig.Status = AttentionStatusOK
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
