package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// maintenance is one maintenance pass's dependencies. Every sweep is a step in
// steps(), run in that order by tick; a failing step is logged and counts
// toward the loop's circuit breaker, and the rest of the pass still runs.
type maintenance struct {
	log        *slog.Logger
	database   *db.DB
	files      *storage.Storage
	settings   *service.SettingsService
	erasure    *service.ErasureService
	retention  *service.RetentionService
	uploads    *service.UploadService
	reports    *service.ReportService
	moderation *service.ModerationService
	// backupDir is backup.dir as configured; maintainBackups resolves it
	// (empty = data/backups).
	backupDir string
	// reportRetentionDays is moderation.report_retention_days (0 = never).
	reportRetentionDays int
	// actionRetentionDays is moderation.action_retention_days (0 = never).
	actionRetentionDays int
	push                *service.PushService
	// attention records each step's outcome for the admin attention panel;
	// nil-safe, so partial wirings skip it.
	attention *service.AttentionService
	// erasureCtx is cancelled when the loop is told to stop, so a resumed
	// erasure drain ends between chunks; the queued job resumes at next start.
	// Nil: no cancellation.
	erasureCtx context.Context
	// stepsOverride replaces steps() when non-nil; a test seam, never set in
	// production.
	stepsOverride []maintenanceStep
}

// maintenanceStep is one sweep: job is its name on the admin attention
// panel, failLog is the warning logged when run fails.
type maintenanceStep struct {
	job     string
	failLog string
	run     func(ctx context.Context) error
}

// newMaintenance builds the pass over the composition root's services. A nil
// svc (a partial wiring in tests) leaves every service-backed step skipped.
func newMaintenance(log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services, files *storage.Storage) *maintenance {
	m := &maintenance{
		log: log, database: database,
		backupDir:           cfg.Backup.Dir,
		reportRetentionDays: cfg.Moderation.ReportRetentionDays,
		actionRetentionDays: cfg.Moderation.ActionRetentionDays,
	}
	if svc != nil {
		m.settings, m.erasure, m.retention, m.uploads = svc.Settings, svc.Erasure, svc.Retention, svc.Uploads
		m.reports = svc.Reports
		m.moderation = svc.Moderation
		m.push = svc.Push
		m.attention = svc.Attention
	}
	// files is the one upload store StartRuntime shares with the router and
	// the erasure replay. It already holds the erasure and retention runners'
	// file remover (wireAuth), so nothing is installed here and no setter runs
	// after the hub started.
	if files == nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled")
		return m
	}
	m.files = files
	return m
}

// startMaintenanceLoop starts the periodic maintenance loop and returns the
// stop step the maintenance stage registers with App.Close.
func startMaintenanceLoop(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services, files *storage.Storage) func() {
	m := newMaintenance(log, cfg, database, svc, files)
	erasureCtx, cancelErasure := context.WithCancel(bgCtx)
	m.erasureCtx = erasureCtx
	stop := runMaintenanceLoop(bgCtx, log, m)
	return func() {
		cancelErasure()
		stop()
	}
}

// runMaintenanceLoop is startMaintenanceLoop over an already-built pass.
func runMaintenanceLoop(bgCtx context.Context, log *slog.Logger, m *maintenance) func() {
	// The attention panel lists every job, in step order, before the loop's
	// start-up runs record outcomes.
	for _, step := range m.steps() {
		m.attention.RegisterJob(step.job, step.failLog)
	}

	// The loop has its own context so the stop step can cancel an in-flight
	// tick (a long VACUUM INTO, an erasure pass) before its bounded join. bgCtx
	// is cancelled only after that join, so a stop that merely closed a channel
	// always waited out the whole 5 s on a busy tick.
	loopCtx, cancelLoop := context.WithCancel(context.WithoutCancel(bgCtx))
	stopMaintenance := make(chan struct{})
	maintenanceDone := make(chan struct{})
	go m.loop(loopCtx, stopMaintenance, maintenanceDone)

	// The attention sampler runs on its own minute cadence, independent of a
	// long tick.
	attentionCtx, stopAttention := context.WithCancel(bgCtx)
	attentionDone := make(chan struct{})
	if m.attention != nil {
		go func() {
			defer close(attentionDone)
			m.attention.Run(attentionCtx, service.AttentionInterval)
		}()
	} else {
		close(attentionDone)
	}

	return func() {
		stopAttention()
		<-attentionDone
		// Bounded join, so an in-flight tick (a scheduled backup's VACUUM INTO
		// can run for seconds) is not using the database when the later Close
		// step tears it down.
		cancelLoop()
		close(stopMaintenance)
		select {
		case <-maintenanceDone:
		case <-time.After(5 * time.Second):
			log.Warn("maintenance loop did not exit before shutdown timeout")
		}
	}
}

// loop is the periodic maintenance goroutine started by startMaintenanceLoop.
func (m *maintenance) loop(bgCtx context.Context, stopMaintenance, maintenanceDone chan struct{}) {
	defer close(maintenanceDone)
	// Erasure jobs interrupted by the last shutdown (files journaled, not
	// removed) finish now, not fifteen minutes from now.
	_ = m.runJob(bgCtx, "Account erasure")
	// reconcileOrphanedVoiceMutes deliberately does not run here: it would run
	// after initDatabase's ClearAllVoiceStates (database.go) wiped every
	// voice_states row, leaving nothing to repair. It runs on the periodic tick
	// only, catching a crash between a lift's ledger commit and its voice
	// finalize, or an expired timeout nobody lifted.
	// Storage counters charged by a process that died between the charge and
	// the write are settled now, so a restart repairs a phantom charge.
	_ = m.runJob(bgCtx, "Storage recount")
	// A VAPID key rotation takes effect on first boot with the new key: the
	// orphaned rows stop being listed at once, and the sweep removes them.
	_ = m.runJob(bgCtx, "Push subscriptions")
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	// An erasure that outran its inline budget, or failed after its lock, asks
	// for a resume now instead of at the next tick. A nil channel never fires.
	var erasureWake <-chan struct{}
	if m.erasure != nil {
		erasureWake = m.erasure.WakeCh()
	}
	consecutiveFailures := 0
	const maxConsecutiveFailures = 5
	for {
		select {
		case <-ticker.C:
			if consecutiveFailures >= maxConsecutiveFailures {
				m.log.Error("maintenance loop: circuit breaker open, skipping tick",
					"consecutive_failures", consecutiveFailures)
				// Reset after one skip to allow retry next tick.
				consecutiveFailures = maxConsecutiveFailures - 1
				continue
			}

			if m.tick(bgCtx) {
				consecutiveFailures++
			} else {
				consecutiveFailures = 0
			}
		case <-erasureWake:
			_ = m.runJob(bgCtx, "Account erasure")
		case <-stopMaintenance:
			return
		}
	}
}

// steps is the pass, in order. Voice mute reconciliation precedes moderation
// action retention so a mute owner is released before its row can be retired.
func (m *maintenance) steps() []maintenanceStep {
	if m.stepsOverride != nil {
		return m.stepsOverride
	}
	return []maintenanceStep{
		{job: "Expired sessions", failLog: "failed to delete expired sessions", run: m.sweepSessions},
		{job: "Delivery receipts", failLog: "failed to delete expired message delivery receipts", run: m.sweepMessageDeliveryReceipts},
		{job: "Second-factor cleanup", failLog: "failed to clean up expired second-factor state", run: m.sweepSecondFactor},
		{job: "Push subscriptions", failLog: "push subscription sweep failed", run: m.sweepPushSubscriptions},
		{job: service.AttentionBackupJob, failLog: "backup maintenance failed", run: m.maintainBackups},
		{job: "Orphaned attachments", failLog: "failed to delete orphaned attachments", run: m.sweepOrphans},
		{job: "Message retention", failLog: "retention sweep failed", run: m.sweepRetention},
		{job: "Report content retention", failLog: "report content retention failed", run: m.pruneReportContent},
		{job: "Voice mute reconciliation", failLog: "orphaned voice mute reconciliation failed", run: m.reconcileOrphanedVoiceMutes},
		{job: "Moderation action retention", failLog: "moderation action retention failed", run: m.retireModerationActions},
		{job: "Account erasure", failLog: "erasure jobs still pending", run: m.resumeErasure},
		{job: "Storage reconciliation", failLog: "storage reconciliation failed", run: m.reconcileFiles},
		// Last on purpose: every sweep above that deletes attachment rows has
		// run, so this recount already returns the bytes they freed.
		{job: "Storage recount", failLog: "storage recount failed", run: m.recountStorage},
	}
}

// tick runs one maintenance pass and reports whether any step of it failed.
func (m *maintenance) tick(ctx context.Context) bool {
	failed := false
	for _, step := range m.steps() {
		// Once the loop is cancelled (shutdown), the remaining steps would
		// only do wasted work.
		if ctx.Err() != nil {
			break
		}
		if m.runStep(ctx, step) != nil {
			failed = true
		}
	}
	return failed
}

// runStep runs one step, records its outcome on the attention panel and logs a
// failure under the step's name.
func (m *maintenance) runStep(ctx context.Context, step maintenanceStep) error {
	err := step.run(ctx)
	m.attention.RecordJob(step.job, err, time.Now())
	// A step cut short by shutdown cancelling its context is not a failure.
	if err != nil && ctx.Err() == nil {
		m.log.Warn(step.failLog, "error", err)
	}
	return err
}

// runJob runs the step named job outside a tick (the loop's start-up runs), so
// its outcome reaches the attention panel at once.
func (m *maintenance) runJob(ctx context.Context, job string) error {
	for _, step := range m.steps() {
		if step.job == job {
			return m.runStep(ctx, step)
		}
	}
	panic("maintenance: no step for job " + job)
}

func (m *maintenance) sweepSessions(ctx context.Context) error {
	return m.database.DeleteExpiredSessions(ctx)
}

func (m *maintenance) sweepMessageDeliveryReceipts(ctx context.Context) error {
	return m.database.DeleteExpiredMessageDeliveryReceipts(ctx)
}

// sweepSecondFactor removes expired login challenges, staged enrolments and
// spent TOTP codes.
func (m *maintenance) sweepSecondFactor(ctx context.Context) error {
	return m.database.CleanupExpiredSecondFactorState(ctx)
}

// sweepPushSubscriptions removes stale Web Push subscriptions and every
// subscription a VAPID key rotation orphaned. A nil push (a partial wiring) is
// a no-op, not a failure.
func (m *maintenance) sweepPushSubscriptions(ctx context.Context) error {
	if m.push == nil {
		return nil
	}
	_, err := m.push.Sweep(ctx)
	return err
}

// maintainBackups runs scheduled backups and retention pruning from the
// backup_schedule / backup_retention admin settings; with no settings service
// there is no schedule to read, so it skips (admin.MaintainBackups reads it
// unconditionally).
func (m *maintenance) maintainBackups(ctx context.Context) error {
	if m.settings == nil {
		return nil
	}
	return admin.MaintainBackups(ctx, m.database, m.settings, admin.ResolveBackupDir(m.backupDir))
}

// sweepOrphans cleans up orphaned attachments (uploaded but never linked to a
// message). It is skipped with no file storage: the row delete is atomic (see
// db/attachment_queries.go), so the returned stored_as names, the only handle
// on the blobs, would be discarded and the files stranded. Leaving the rows
// keeps them reclaimable once storage is available.
func (m *maintenance) sweepOrphans(ctx context.Context) error {
	if m.files == nil {
		return nil
	}
	cutoff := time.Now().Add(-1 * time.Hour)
	orphanFiles, err := m.database.DeleteOrphanedAttachments(ctx, cutoff)
	if err != nil {
		return err
	}
	if len(orphanFiles) == 0 {
		return nil
	}
	// Best-effort file cleanup.
	for _, filename := range orphanFiles {
		if delErr := m.files.Delete(filename); delErr != nil {
			m.log.Warn("failed to delete orphan file", "file", filename, "error", delErr)
		}
	}
	m.log.Info("cleaned up orphaned attachments", "count", len(orphanFiles))
	return nil
}

// sweepRetention is message retention: one bounded sweep per tick over every
// channel with an effective window; a server without a policy does nothing.
func (m *maintenance) sweepRetention(ctx context.Context) error {
	if m.retention == nil {
		return nil
	}
	rep, err := m.retention.Tick(ctx)
	if err != nil {
		return fmt.Errorf("%w (messages=%d)", err, rep.Messages)
	}
	return nil
}

// pruneReportContent is the report-content retention step
// (moderation.report_retention_days, default 180, 0 = never): it deletes the
// evidence and notes and clears the detail of every report closed longer ago
// than the window. The reports row itself is kept.
func (m *maintenance) pruneReportContent(ctx context.Context) error {
	if m.reports == nil || m.reportRetentionDays <= 0 {
		return nil
	}
	return m.reports.PruneClosedContent(ctx, time.Duration(m.reportRetentionDays)*24*time.Hour)
}

// retireModerationActions is the moderation-action retention step
// (moderation.action_retention_days, default 90, 0 = never), run right after
// report content retention (TestMaintenance_StepOrderIsPinned): warning rows
// retire after acknowledged_at, timeout rows after expires_at/lifted_at. Ban,
// kick and removal rows are never touched.
func (m *maintenance) retireModerationActions(ctx context.Context) error {
	if m.actionRetentionDays <= 0 {
		return nil
	}
	_, err := m.database.RetireModerationActions(ctx, m.actionRetentionDays)
	return err
}

// reconcileOrphanedVoiceMutes gives every voice_states row whose
// server_muted_by points at a lifted or expired timeout the same post-commit
// finalize (ModerationService.FinalizeTimeoutLift) a normal lift runs, with
// actor 0 (system-initiated). That repairs a crash between a lift's ledger
// commit and its finalize, and the gap that left a naturally expired timeout's
// voice mute in effect forever. Tick-only: at loop start initDatabase's
// ClearAllVoiceStates has already wiped every row, and a row is real again
// only once a client re-joins.
func (m *maintenance) reconcileOrphanedVoiceMutes(ctx context.Context) error {
	if m.moderation == nil {
		return nil
	}
	orphans, err := m.database.FindOrphanedVoiceMutes(ctx)
	if err != nil {
		return err
	}
	for _, o := range orphans {
		m.moderation.FinalizeTimeoutLift(ctx, o.UserID, []int64{o.ActionID}, 0)
	}
	if len(orphans) > 0 {
		m.log.Info("reconciled orphaned voice mutes", "count", len(orphans))
	}
	return nil
}

// resumeErasure runs every unfinished erasure job once (no runner is a
// success), at loop start and every tick.
func (m *maintenance) resumeErasure(ctx context.Context) error {
	if m.erasure == nil {
		return nil
	}
	if m.erasureCtx != nil {
		// Ends the drain between chunks once the loop is told to stop.
		var cancel context.CancelFunc
		ctx, cancel = context.WithCancel(ctx)
		defer cancel()
		defer context.AfterFunc(m.erasureCtx, cancel)() //nolint:contextcheck // erasureCtx is the loop's own stop signal, derived from its lifecycle context
	}
	done, err := m.erasure.Resume(ctx)
	if done > 0 {
		m.log.Info("erasure jobs completed", "count", done)
	}
	return err
}

// reconcileFiles is the reconciliation pass: files in upload storage that no
// row names, as the orphan sweep strands when it stops between its DELETE and
// its unlinks or a restore leaves behind. Bounded per tick and only past the
// same one-hour grace an in-flight upload gets.
func (m *maintenance) reconcileFiles(ctx context.Context) error {
	if m.erasure == nil || m.files == nil {
		return nil
	}
	removed, err := m.erasure.Reconcile(ctx, m.files, time.Now().Add(-1*time.Hour), reconcileFilesPerTick)
	if err != nil {
		return err
	}
	if removed > 0 {
		m.log.Info("storage reconciliation removed stranded files", "count", removed)
	}
	return nil
}

// recountStorage sets every per-user upload byte counter to the rows that name
// the user's files plus what is in flight. The counter is a cache of the rows,
// and this is where erasure, retention and the orphan sweep return bytes.
func (m *maintenance) recountStorage(ctx context.Context) error {
	if m.uploads == nil {
		return nil
	}
	_, err := m.uploads.RecountStorage(ctx)
	return err
}

// reconcileFilesPerTick bounds how many stranded files one maintenance tick
// removes; the rest wait for the next tick.
const reconcileFilesPerTick = 500
