package service

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/syncutil"
)

// Signal statuses. Unknown is a measurement the server could not take and is never
// reported as healthy: it neither raises nor recovers a warning.
const (
	AttentionStatusUnknown  = "unknown"
	AttentionStatusOK       = "ok"
	AttentionStatusWarning  = "warning"
	AttentionStatusCritical = "critical"
)

// AttentionBackupJob is the maintenance step whose runs decide whether a server with no
// backup is waiting for its first run (unknown) or failing (warning).
const AttentionBackupJob = "Backups"

const attentionBackupSignal = "backup"

// AttentionInterval is how often Run samples the sources.
const AttentionInterval = time.Minute

const (
	attentionSustain = 2
	// Rate signals learn a baseline (EWMA of healthy samples) and raise at the configured
	// floor or attentionBaselineFactor times the baseline, whichever is higher, once warm.
	attentionBaselineFactor = 3.0
	attentionBaselineAlpha  = 0.1
	attentionBaselineWarmup = 10
	// A raised rate clears only below this fraction of its threshold, a disk level only
	// above this multiple of its floor.
	attentionRateClearRatio  = 0.5
	attentionDiskClearMargin = 1.1
	attentionJobFailures     = 2
	// A self-signed or manual certificate warns inside attentionCertWarn of expiry and is
	// critical inside attentionCertCritical. ACME is measured against its renewal point
	// (see evalCertificate).
	attentionCertWarn      = 21 * 24 * time.Hour
	attentionCertCritical  = 7 * 24 * time.Hour
	attentionACMERenewMax  = 30 * 24 * time.Hour
	attentionRecoveredKeep = 24 * time.Hour
)

// AttentionThresholds are the operator's floors (attention.* plus server.min_free_disk_mb).
type AttentionThresholds struct {
	DiskWarnFreeBytes     uint64
	DiskCriticalFreeBytes uint64 // 0 disables the critical level
	WriterWaitMsPerMin    float64
	ReconnectsPerMin      float64
	DeliveryDropsPerMin   float64
}

// VoiceHealth is the LiveKit voice path's state. A managed companion reports its
// supervisor state; external LiveKit reports Reachable from a probe; an unconfigured
// path is Managed false with no probe (unknown).
type VoiceHealth struct {
	Managed   bool
	Running   bool
	Restarts  int
	GaveUp    bool
	Reachable *bool
}

// AttentionSources are the in-process readings. Counters are cumulative since start; a
// nil source reports unknown.
type AttentionSources struct {
	DiskFree       func() (uint64, error)
	WriterWait     func() time.Duration
	Reconnects     func() uint64
	DeliveryDrops  func() uint64
	DispatchAlive  func() bool
	BackupSchedule func(context.Context) (string, error)
	LastBackup     func() (time.Time, error)
	// VoiceHealth gets the sample context so an external LiveKit is probed with a bounded
	// timeout. Nil reports unknown, never healthy.
	VoiceHealth func(context.Context) VoiceHealth
	// Certificate reports tls.mode and the served leaf, zero when none is known.
	Certificate func() (mode string, cert auth.ServedCert)
}

// BootStatus is what the previous run left in the boot marker.
type BootStatus struct {
	// Recorded: a marker was found and read. False on a first start (unknown, not a warning).
	Recorded bool
	// Unclean: the previous run ended without clearing its marker.
	Unclean     bool
	StartedAt   time.Time
	LastPanicAt time.Time
}

// RestoreOutcome is what the boot-time apply of a staged restore left; Recorded is false
// when none was pending.
type RestoreOutcome struct {
	Recorded bool
	Status   string
	Backup   string
	At       time.Time
	Reason   string
}

// AttentionSignal is one measurement and its current status.
type AttentionSignal struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	Status     string    `json:"status"`
	Value      string    `json:"value,omitempty"`
	Threshold  string    `json:"threshold,omitempty"`
	Detail     string    `json:"detail,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

// AttentionWarning is one deduplicated warning: a signal that resumes failing updates its entry.
type AttentionWarning struct {
	ID            string     `json:"id"`
	Severity      string     `json:"severity"`
	Title         string     `json:"title"`
	Detail        string     `json:"detail"`
	Action        string     `json:"action"`
	FirstObserved time.Time  `json:"first_observed"`
	LastObserved  time.Time  `json:"last_observed"`
	Occurrences   int        `json:"occurrences"`
	RecoveredAt   *time.Time `json:"recovered_at"`
}

// AttentionReport is what GET /admin/api/attention returns.
type AttentionReport struct {
	EvaluatedAt *time.Time         `json:"evaluated_at"`
	Signals     []AttentionSignal  `json:"signals"`
	Warnings    []AttentionWarning `json:"warnings"`
}

// AttentionService is the admin attention panel's state: samples, deduplicated warnings
// with hysteresis. State is in memory only; a restart forgets recovered-warning history
// and active conditions re-raise on the next samples.
type AttentionService struct {
	thresholds AttentionThresholds
	src        AttentionSources

	mu          syncutil.Mutex
	evaluatedAt time.Time
	signals     []AttentionSignal
	warnings    map[string]*AttentionWarning
	disk        attentionLevel
	writerWait  attentionRate
	reconnects  attentionRate
	delivery    attentionRate
	voice       attentionLevel
	jobs        []*attentionJob
	boot        BootStatus
	restore     RestoreOutcome
}

type attentionJob struct {
	label, logHint       string
	lastRun, lastSuccess time.Time
	lastErr              string
	consecutiveFailures  int
}

// WriterWaitSource reads the SQLite writer pool's cumulative queueing time.
func WriterWaitSource(database *db.DB) func() time.Duration {
	return func() time.Duration { return database.SQLDb().Stats().WaitDuration }
}

// PoolStatsSources returns the writer and reader pools' Stats readers so the root names no raw pool.
func PoolStatsSources(database *db.DB) (writer, reader func() sql.DBStats) {
	return func() sql.DBStats { return database.SQLDb().Stats() },
		func() sql.DBStats { return database.SQLReaderDB().Stats() }
}

// NewAttentionService builds the service over its thresholds and sources.
func NewAttentionService(t AttentionThresholds, src AttentionSources) *AttentionService {
	return &AttentionService{thresholds: t, src: src, warnings: map[string]*AttentionWarning{}}
}

// RegisterJob declares a maintenance job so it is listed (unknown) before its first run;
// logHint is the message its failure is logged under.
func (s *AttentionService) RegisterJob(label, logHint string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.job(label) == nil {
		s.jobs = append(s.jobs, &attentionJob{label: label, logHint: logHint})
	}
}

// RecordJob records one run of a maintenance job.
func (s *AttentionService) RecordJob(label string, err error, at time.Time) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.job(label)
	if j == nil {
		j = &attentionJob{label: label}
		s.jobs = append(s.jobs, j)
	}
	j.lastRun = at
	if err != nil {
		j.consecutiveFailures++
		j.lastErr = err.Error()
		return
	}
	j.consecutiveFailures, j.lastErr, j.lastSuccess = 0, "", at
}

func (s *AttentionService) job(label string) *attentionJob {
	for _, j := range s.jobs {
		if j.label == label {
			return j
		}
	}
	return nil
}

// RecordBootStatus records the previous run's marker; set once at start-up, before Run samples.
func (s *AttentionService) RecordBootStatus(b BootStatus) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.boot = b
}

// RecordRestoreOutcome records the staged restore the boot-time apply handled; set once at start-
// up, before Run samples.
func (s *AttentionService) RecordRestoreOutcome(r RestoreOutcome) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.restore = r
}

// Run evaluates now and then every interval until ctx ends.
func (s *AttentionService) Run(ctx context.Context, interval time.Duration) {
	s.Evaluate(ctx, time.Now())
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.Evaluate(ctx, now)
		}
	}
}

type attentionReadings struct {
	diskFree      uint64
	diskErr       error
	writerWait    *float64
	reconnects    *float64
	deliveryDrops *float64
	dispatchAlive bool
	schedule      string
	scheduleErr   error
	lastBackup    time.Time
	lastBackupErr error
	voice         *VoiceHealth
	certMode      string
	cert          auth.ServedCert
	certMeasured  bool
}

func (s *AttentionService) read(ctx context.Context) attentionReadings {
	r := attentionReadings{dispatchAlive: true}
	r.diskErr = errors.New("disk space is not measured on this server")
	if s.src.DiskFree != nil {
		r.diskFree, r.diskErr = s.src.DiskFree()
	}
	counter := func(f func() uint64) *float64 {
		if f == nil {
			return nil
		}
		v := float64(f())
		return &v
	}
	if s.src.WriterWait != nil {
		ms := float64(s.src.WriterWait().Milliseconds())
		r.writerWait = &ms
	}
	r.reconnects, r.deliveryDrops = counter(s.src.Reconnects), counter(s.src.DeliveryDrops)
	if s.src.DispatchAlive != nil {
		r.dispatchAlive = s.src.DispatchAlive()
	}
	if s.src.VoiceHealth != nil {
		v := s.src.VoiceHealth(ctx)
		r.voice = &v
	}
	if s.src.Certificate != nil {
		r.certMode, r.cert = s.src.Certificate()
		r.certMeasured = true
	}
	// Last, after the voice probe that can block: a concurrent 'Backup now' refresh must not
	// be overwritten by an older reading.
	s.readBackup(ctx, &r)
	return r
}

// Evaluate takes one sample at now and updates signals and warnings.
func (s *AttentionService) Evaluate(ctx context.Context, now time.Time) {
	r := s.read(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.evaluatedAt = now
	s.signals = s.signals[:0]
	s.evalDisk(r, now)
	s.evalRate(&s.writerWait, r.writerWait, now, rateSpec{
		id: "db_writer_wait", label: "Database writer wait", unit: "ms/min", floor: s.thresholds.WriterWaitMsPerMin,
		title:  "Database writes are queueing",
		action: "Check Server Logs for long-running writes (retention sweeps, bulk deletes). Sustained waits mean the single SQLite writer is saturated.",
	})
	s.evalRate(&s.reconnects, r.reconnects, now, rateSpec{
		id: "reconnects", label: "Client reconnects", unit: "/min", floor: s.thresholds.ReconnectsPerMin,
		title:       "Clients are reconnecting more than usual",
		action:      "Check network, reverse-proxy and TLS stability, and Server Logs for disconnect causes.",
		quietWarmup: true,
	})
	s.evalRate(&s.delivery, r.deliveryDrops, now, rateSpec{
		id: "delivery", label: "Delivery pressure", unit: "/min", floor: s.thresholds.DeliveryDropsPerMin,
		title:  "Messages are being dropped or slow clients disconnected",
		action: "The server is sending faster than clients receive. Check CPU, network bandwidth and connected users; restart the server if dispatch has stopped.",
		dead:   !r.dispatchAlive,
	})
	s.evalBackup(r, now)
	s.evalVoice(r, now)
	s.evalCertificate(r, now)
	s.evalBootStatus(now)
	s.evalRestoreOutcome(now)
	s.evalJobs(now)
	for id, w := range s.warnings {
		if w.RecoveredAt != nil && now.Sub(*w.RecoveredAt) > attentionRecoveredKeep {
			delete(s.warnings, id)
		}
	}
}

// Report returns a copy: active warnings first (most severe first), then recovered, newest first.
func (s *AttentionService) Report() AttentionReport {
	s.mu.Lock()
	defer s.mu.Unlock()
	rep := AttentionReport{Signals: slices.Clone(s.signals), Warnings: make([]AttentionWarning, 0, len(s.warnings))}
	if rep.Signals == nil {
		rep.Signals = []AttentionSignal{}
	}
	if !s.evaluatedAt.IsZero() {
		at := s.evaluatedAt
		rep.EvaluatedAt = &at
	}
	for _, w := range s.warnings {
		c := *w
		if w.RecoveredAt != nil {
			at := *w.RecoveredAt
			c.RecoveredAt = &at
		}
		rep.Warnings = append(rep.Warnings, c)
	}
	rank := func(w AttentionWarning) int {
		switch {
		case w.RecoveredAt != nil:
			return 2
		case w.Severity == AttentionStatusCritical:
			return 0
		}
		return 1
	}
	slices.SortFunc(rep.Warnings, func(a, b AttentionWarning) int {
		if d := rank(a) - rank(b); d != 0 {
			return d
		}
		return b.LastObserved.Compare(a.LastObserved)
	})
	return rep
}

func (s *AttentionService) settle(sig AttentionSignal, title, action string) {
	s.signals = append(s.signals, sig)
	now := sig.ObservedAt
	w := s.warnings[sig.ID]
	switch sig.Status {
	case AttentionStatusWarning, AttentionStatusCritical:
		var parts []string
		for _, p := range []string{sig.Value, sig.Threshold, sig.Detail} {
			if p != "" {
				parts = append(parts, p)
			}
		}
		detail := strings.Join(parts, " · ")
		if w == nil {
			w = &AttentionWarning{ID: sig.ID}
			s.warnings[sig.ID] = w
		}
		if w.Occurrences == 0 || w.RecoveredAt != nil {
			w.Occurrences++
			w.FirstObserved = now
		}
		w.Severity, w.Title, w.Detail, w.Action = sig.Status, title, detail, action
		w.LastObserved, w.RecoveredAt = now, nil
	case AttentionStatusOK:
		if w != nil && w.RecoveredAt == nil {
			w.RecoveredAt = &now
		}
	}
}
