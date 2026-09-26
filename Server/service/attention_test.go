package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// attentionFixture drives an AttentionService through fake sources on a
// fake clock, one Evaluate per step().
type attentionFixture struct {
	t        *testing.T
	s        *AttentionService
	now      time.Time
	free     uint64
	diskErr  error
	waitMs   int64
	resumes  uint64
	drops    uint64
	alive    bool
	schedule string
	last     time.Time
}

func newAttentionFixture(t *testing.T) *attentionFixture {
	t.Helper()
	f := &attentionFixture{t: t, now: time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC), free: 10 << 30, alive: true, schedule: "off"}
	f.last = f.now
	f.s = NewAttentionService(AttentionThresholds{
		DiskWarnFreeBytes:     1024 << 20,
		DiskCriticalFreeBytes: 256 << 20,
		WriterWaitMsPerMin:    5000,
		ReconnectsPerMin:      30,
		DeliveryDropsPerMin:   1,
	}, AttentionSources{
		DiskFree:       func() (uint64, error) { return f.free, f.diskErr },
		WriterWait:     func() time.Duration { return time.Duration(f.waitMs) * time.Millisecond },
		Reconnects:     func() uint64 { return f.resumes },
		DeliveryDrops:  func() uint64 { return f.drops },
		DispatchAlive:  func() bool { return f.alive },
		BackupSchedule: func(context.Context) (string, error) { return f.schedule, nil },
		LastBackup:     func() (time.Time, error) { return f.last, nil },
	})
	return f
}

// step advances the clock one minute and evaluates.
func (f *attentionFixture) step() AttentionReport {
	f.now = f.now.Add(time.Minute)
	f.s.Evaluate(context.Background(), f.now)
	return f.s.Report()
}

func signal(t *testing.T, rep AttentionReport, id string) AttentionSignal {
	t.Helper()
	for _, s := range rep.Signals {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("no signal %q in %+v", id, rep.Signals)
	return AttentionSignal{}
}

func warning(rep AttentionReport, id string) *AttentionWarning {
	for i := range rep.Warnings {
		if rep.Warnings[i].ID == id {
			return &rep.Warnings[i]
		}
	}
	return nil
}

func wantStatus(t *testing.T, rep AttentionReport, id, want string) {
	t.Helper()
	if got := signal(t, rep, id).Status; got != want {
		t.Fatalf("%s status = %q, want %q (%+v)", id, got, want, signal(t, rep, id))
	}
}

// An unmeasured source is unknown, never healthy, and raises nothing.
func TestAttention_UnknownIsNotHealthy(t *testing.T) {
	s := NewAttentionService(AttentionThresholds{WriterWaitMsPerMin: 1, ReconnectsPerMin: 1, DeliveryDropsPerMin: 1}, AttentionSources{})
	s.Evaluate(context.Background(), time.Now())
	rep := s.Report()
	if rep.EvaluatedAt == nil {
		t.Fatal("EvaluatedAt is nil after Evaluate")
	}
	for _, id := range []string{"disk", "db_writer_wait", "reconnects", "delivery", "backup"} {
		wantStatus(t, rep, id, AttentionStatusUnknown)
	}
	if len(rep.Warnings) != 0 {
		t.Fatalf("unknown signals raised warnings: %+v", rep.Warnings)
	}

	// Before the first sample there is no evaluation time at all.
	if NewAttentionService(AttentionThresholds{}, AttentionSources{}).Report().EvaluatedAt != nil {
		t.Fatal("EvaluatedAt set before any evaluation")
	}
}

// A rate needs two samples; the first is unknown, the second is measured.
func TestAttention_RateFirstSampleIsUnknown(t *testing.T) {
	f := newAttentionFixture(t)
	wantStatus(t, f.step(), "reconnects", AttentionStatusUnknown)
	wantStatus(t, f.step(), "reconnects", AttentionStatusOK)
}

// A disk warning commits only after two samples, holds inside the clear
// margin, and recovers only after two samples clear of it.
func TestAttention_DiskHysteresis(t *testing.T) {
	f := newAttentionFixture(t)
	wantStatus(t, f.step(), "disk", AttentionStatusOK)

	f.free = 900 << 20 // below the 1024 MB warn floor
	wantStatus(t, f.step(), "disk", AttentionStatusOK)
	rep := f.step()
	wantStatus(t, rep, "disk", AttentionStatusWarning)
	if w := warning(rep, "disk"); w == nil || w.Action == "" || w.RecoveredAt != nil {
		t.Fatalf("disk warning = %+v, want an active warning with an action", w)
	}

	f.free = 1100 << 20 // above the floor but inside the 10% clear margin
	wantStatus(t, f.step(), "disk", AttentionStatusWarning)
	wantStatus(t, f.step(), "disk", AttentionStatusWarning)

	f.free = 200 << 20 // below server.min_free_disk_mb
	f.step()
	rep = f.step()
	wantStatus(t, rep, "disk", AttentionStatusCritical)
	if w := warning(rep, "disk"); w.Severity != AttentionStatusCritical || w.Occurrences != 1 {
		t.Fatalf("escalation = %+v, want the same warning at critical, one occurrence", w)
	}

	f.free = 2 << 30
	wantStatus(t, f.step(), "disk", AttentionStatusCritical)
	rep = f.step()
	wantStatus(t, rep, "disk", AttentionStatusOK)
	if w := warning(rep, "disk"); w == nil || w.RecoveredAt == nil {
		t.Fatalf("disk warning after recovery = %+v, want it kept with a recovery time", w)
	}
}

// The disk threshold lists only the enabled levels; a 0 warn floor leaves
// only the critical level, and no floor at all is not checked rather than
// healthy.
func TestAttention_DiskFloors(t *testing.T) {
	disk := func(warn, crit, free uint64) AttentionReport {
		s := NewAttentionService(AttentionThresholds{DiskWarnFreeBytes: warn, DiskCriticalFreeBytes: crit},
			AttentionSources{DiskFree: func() (uint64, error) { return free, nil }})
		now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
		for range 2 {
			now = now.Add(time.Minute)
			s.Evaluate(context.Background(), now)
		}
		return s.Report()
	}

	if got := signal(t, disk(1024<<20, 0, 10<<30), "disk").Threshold; got != "warn below 1024 MB" {
		t.Errorf("critical disabled: threshold = %q, want only the warn floor", got)
	}

	rep := disk(0, 256<<20, 200<<20)
	if got := signal(t, rep, "disk").Threshold; got != "critical below 256 MB" {
		t.Errorf("warn disabled: threshold = %q, want only the critical floor", got)
	}
	wantStatus(t, rep, "disk", AttentionStatusCritical)
	if got := signal(t, disk(0, 256<<20, 10<<30), "disk").Status; got != AttentionStatusOK {
		t.Errorf("warn disabled, plenty free: status = %q, want ok", got)
	}

	rep = disk(0, 0, 1<<20)
	sig := signal(t, rep, "disk")
	if sig.Status != AttentionStatusUnknown || sig.Threshold != "" || sig.Detail == "" {
		t.Errorf("both floors 0: disk = %+v, want unknown with a not-checked detail and no threshold", sig)
	}
	if len(rep.Warnings) != 0 {
		t.Errorf("both floors 0 raised warnings: %+v", rep.Warnings)
	}
}

// A single noisy sample neither raises nor clears.
func TestAttention_SingleSpikeDoesNotRaise(t *testing.T) {
	f := newAttentionFixture(t)
	f.warmUp()
	f.resumes += 100
	wantStatus(t, f.step(), "reconnects", AttentionStatusOK)
	rep := f.step()
	wantStatus(t, rep, "reconnects", AttentionStatusOK)
	if len(rep.Warnings) != 0 {
		t.Fatalf("one spike raised %+v", rep.Warnings)
	}
}

// The measured baseline raises the threshold above the configured floor, and
// a raised rate clears only below half the threshold.
func TestAttention_RateBaselineAndClearBand(t *testing.T) {
	f := newAttentionFixture(t)
	f.step()
	f.resumes += 3000 // every client's resume right after a restart: not learned
	f.step()
	for range attentionBaselineWarmup {
		f.resumes += 100 // a busy server's normal: well above the floor of 30
		f.step()
	}
	f.resumes += 100
	rep := f.step()
	wantStatus(t, rep, "reconnects", AttentionStatusOK)
	sig := signal(t, rep, "reconnects")
	if sig.Threshold != "raise at 300.0 /min" {
		t.Fatalf("threshold = %q, want 3x the learned 100/min baseline", sig.Threshold)
	}

	for range 2 {
		f.resumes += 400
		rep = f.step()
	}
	wantStatus(t, rep, "reconnects", AttentionStatusWarning)

	// 200/min is under the raise threshold but above the 150/min clear band.
	for range 3 {
		f.resumes += 200
		rep = f.step()
	}
	wantStatus(t, rep, "reconnects", AttentionStatusWarning)

	for range 2 {
		f.resumes += 100
		rep = f.step()
	}
	wantStatus(t, rep, "reconnects", AttentionStatusOK)
	// The pressure did not become the new normal.
	if sig := signal(t, rep, "reconnects"); sig.Threshold != "raise at 300.0 /min" {
		t.Fatalf("threshold after the episode = %q, want the baseline unchanged", sig.Threshold)
	}
}

// warmUp primes every rate, measures the unlearned first interval and folds
// attentionBaselineWarmup quiet samples.
func (f *attentionFixture) warmUp() {
	f.step()
	for range attentionBaselineWarmup + 1 {
		f.step()
	}
}

// Reconnect warm-up learns and raises nothing, however high the rate.
func TestAttention_ReconnectWarmUpDoesNotRaise(t *testing.T) {
	f := newAttentionFixture(t)
	f.step()
	for range attentionBaselineWarmup + 1 {
		f.resumes += 1000
		if rep := f.step(); len(rep.Warnings) != 0 {
			t.Fatalf("warm-up raised %+v", rep.Warnings)
		}
	}
}

// Writer wait saturated at boot raises at the floor during warm-up and is
// not learned, so it raises again once the baseline is established.
func TestAttention_BootPressureIsRaisedNotLearned(t *testing.T) {
	f := newAttentionFixture(t)
	f.step()
	f.waitMs += 20_000 // 4x the 5000 ms/min floor
	wantStatus(t, f.step(), "db_writer_wait", AttentionStatusOK)
	for range attentionBaselineWarmup {
		f.waitMs += 20_000
		wantStatus(t, f.step(), "db_writer_wait", AttentionStatusWarning)
	}
	for range attentionBaselineWarmup {
		f.step()
	}
	rep := f.step()
	wantStatus(t, rep, "db_writer_wait", AttentionStatusOK)
	if sig := signal(t, rep, "db_writer_wait"); sig.Detail != "baseline 0.0 ms/min" || sig.Threshold != "raise at 5000.0 ms/min" {
		t.Fatalf("after warm-up = %+v, want the quiet baseline and the floor", sig)
	}
	for range 2 {
		f.waitMs += 20_000
		rep = f.step()
	}
	wantStatus(t, rep, "db_writer_wait", AttentionStatusWarning)
}

// One high first rate interval, such as the resume burst after a restart,
// does not raise.
func TestAttention_FirstRateIntervalNeedsSustain(t *testing.T) {
	f := newAttentionFixture(t)
	f.step()
	f.waitMs += 20_000
	f.drops += 50
	f.step()
	rep := f.step()
	wantStatus(t, rep, "db_writer_wait", AttentionStatusOK)
	wantStatus(t, rep, "delivery", AttentionStatusOK)
	if len(rep.Warnings) != 0 {
		t.Fatalf("one high first interval raised %+v", rep.Warnings)
	}
}

// The first disk level and a stopped dispatch loop commit at once rather
// than reading as healthy.
func TestAttention_FirstMeasuredLevelCommits(t *testing.T) {
	f := newAttentionFixture(t)
	f.free = 100 << 20
	f.alive = false
	wantStatus(t, f.step(), "disk", AttentionStatusCritical)
	wantStatus(t, f.step(), "delivery", AttentionStatusCritical)
}

// Over a quiet baseline the configured floor is the threshold.
func TestAttention_WriterWaitFloor(t *testing.T) {
	f := newAttentionFixture(t)
	f.warmUp()
	for range 2 {
		f.waitMs += 6000
		f.step()
	}
	rep := f.s.Report()
	wantStatus(t, rep, "db_writer_wait", AttentionStatusWarning)
	if w := warning(rep, "db_writer_wait"); w == nil || w.Detail == "" {
		t.Fatalf("writer wait warning = %+v, want the measured value in its detail", w)
	}
}

// A warning that keeps firing, recovers and fires again stays one entry.
func TestAttention_WarningsAreDeduplicated(t *testing.T) {
	f := newAttentionFixture(t)
	f.warmUp()
	raise := func() {
		for range 2 {
			f.drops += 5
			f.step()
		}
	}
	raise()
	first := warning(f.s.Report(), "delivery")
	if first == nil {
		t.Fatal("no delivery warning")
	}
	firstAt := first.FirstObserved
	for range 5 {
		f.drops += 5
		f.step()
	}
	if w := warning(f.s.Report(), "delivery"); w.Occurrences != 1 || !w.LastObserved.Equal(f.now) {
		t.Fatalf("sustained warning = %+v, want one occurrence observed now", w)
	}

	f.step()
	f.step()
	rec := warning(f.s.Report(), "delivery")
	if rec.RecoveredAt == nil {
		t.Fatalf("warning not recovered: %+v", rec)
	}

	raise()
	rep := f.s.Report()
	n := 0
	for _, w := range rep.Warnings {
		if w.ID == "delivery" {
			n++
		}
	}
	w := warning(rep, "delivery")
	if n != 1 || w.Occurrences != 2 || w.RecoveredAt != nil || !w.FirstObserved.Equal(firstAt) {
		t.Fatalf("recurrence = %d entries, %+v; want one reopened entry with two occurrences", n, w)
	}
}

// Losing a measurement never recovers an active warning.
func TestAttention_UnknownDoesNotRecover(t *testing.T) {
	f := newAttentionFixture(t)
	f.free = 100 << 20
	f.step()
	f.step()
	f.diskErr = errors.New("statfs failed")
	rep := f.step()
	wantStatus(t, rep, "disk", AttentionStatusUnknown)
	if w := warning(rep, "disk"); w == nil || w.RecoveredAt != nil {
		t.Fatalf("disk warning = %+v, want still active while unmeasured", w)
	}
}

// Recovered warnings are listed for a day, then dropped.
func TestAttention_RecoveredWarningsExpire(t *testing.T) {
	f := newAttentionFixture(t)
	f.free = 100 << 20
	f.step()
	f.step()
	f.free = 10 << 30
	f.step()
	f.step()
	if w := warning(f.s.Report(), "disk"); w == nil || w.RecoveredAt == nil {
		t.Fatalf("want a recovered disk warning, got %+v", w)
	}
	f.now = f.now.Add(attentionRecoveredKeep)
	if w := warning(f.step(), "disk"); w != nil {
		t.Fatalf("recovered warning still listed after a day: %+v", w)
	}
}

// A stopped dispatch loop is critical on its own.
func TestAttention_DeadDispatchIsCritical(t *testing.T) {
	f := newAttentionFixture(t)
	f.step()
	wantStatus(t, f.step(), "delivery", AttentionStatusOK)
	f.alive = false
	rep := f.step()
	wantStatus(t, rep, "delivery", AttentionStatusCritical)
	if len(rep.Warnings) == 0 || rep.Warnings[0].ID != "delivery" {
		t.Fatalf("critical warning not first: %+v", rep.Warnings)
	}
}

func TestAttention_JobHealth(t *testing.T) {
	f := newAttentionFixture(t)
	f.s.RegisterJob("Message retention", "retention sweep failed")
	wantStatus(t, f.step(), "job:Message retention", AttentionStatusUnknown)

	f.s.RecordJob("Message retention", nil, f.now)
	wantStatus(t, f.step(), "job:Message retention", AttentionStatusOK)

	f.s.RecordJob("Message retention", errors.New("disk I/O error"), f.now)
	rep := f.step()
	wantStatus(t, rep, "job:Message retention", AttentionStatusOK) // one failure is tolerated
	if d := signal(t, rep, "job:Message retention").Detail; d != "last run failed: disk I/O error" {
		t.Fatalf("detail = %q", d)
	}

	f.s.RecordJob("Message retention", errors.New("disk I/O error"), f.now)
	rep = f.step()
	wantStatus(t, rep, "job:Message retention", AttentionStatusWarning)
	w := warning(rep, "job:Message retention")
	if w == nil || w.Action == "" || w.Title != "Maintenance job failing: Message retention" {
		t.Fatalf("job warning = %+v", w)
	}

	f.s.RecordJob("Message retention", nil, f.now)
	if w := warning(f.step(), "job:Message retention"); w == nil || w.RecoveredAt == nil {
		t.Fatalf("job warning after a success = %+v, want recovered", w)
	}

	var nilSvc *AttentionService
	nilSvc.RecordJob("x", nil, f.now) // partial wirings must not panic
	nilSvc.RegisterJob("x", "")
}

func TestAttention_Backup(t *testing.T) {
	cases := []struct {
		name     string
		schedule string
		age      time.Duration // 0 = no backup at all
		jobRan   bool
		want     string
	}{
		{"off with a backup", "off", time.Hour, false, AttentionStatusOK},
		{"off with none", "off", 0, false, AttentionStatusWarning},
		{"daily none yet, job not run", "daily", 0, false, AttentionStatusUnknown},
		{"daily none after a run", "daily", 0, true, AttentionStatusWarning},
		{"daily fresh", "daily", 20 * time.Hour, true, AttentionStatusOK},
		{"daily overdue", "daily", 40 * time.Hour, true, AttentionStatusWarning},
		{"daily long overdue", "daily", 80 * time.Hour, true, AttentionStatusCritical},
		{"weekly within", "weekly", 8 * 24 * time.Hour, true, AttentionStatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newAttentionFixture(t)
			f.schedule = tc.schedule
			f.last = time.Time{}
			if tc.age > 0 {
				f.last = f.now.Add(time.Minute - tc.age)
			}
			if tc.jobRan {
				f.s.RecordJob(AttentionBackupJob, nil, f.now)
			}
			wantStatus(t, f.step(), "backup", tc.want)
		})
	}
}

// A missing backup_schedule row is the default "off", not a read failure;
// any other read failure is unknown.
func TestAttention_BackupScheduleErrors(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{fmt.Errorf("get: %w", db.ErrNotFound), AttentionStatusOK},
		{errors.New("database is locked"), AttentionStatusUnknown},
	} {
		s := NewAttentionService(AttentionThresholds{}, AttentionSources{
			BackupSchedule: func(context.Context) (string, error) { return "", tc.err },
			LastBackup:     func() (time.Time, error) { return time.Now(), nil },
		})
		s.Evaluate(context.Background(), time.Now())
		wantStatus(t, s.Report(), "backup", tc.want)
	}
}

// Run evaluates immediately and stops with its context.
func TestAttention_RunStopsWithContext(t *testing.T) {
	s := NewAttentionService(AttentionThresholds{}, AttentionSources{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Run(ctx, time.Hour)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for s.Report().EvaluatedAt == nil {
		if time.Now().After(deadline) {
			t.Fatal("Run did not evaluate at start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
}

func TestBackupScheduleInterval(t *testing.T) {
	for schedule, want := range map[string]time.Duration{
		"daily": 24 * time.Hour, " Weekly ": 7 * 24 * time.Hour, "off": 0, "": 0, "hourly": 0, //nolint:gocritic // padded key proves trimming and case folding
	} {
		if got := BackupScheduleInterval(schedule); got != want {
			t.Errorf("BackupScheduleInterval(%q) = %v, want %v", schedule, got, want)
		}
	}
}
