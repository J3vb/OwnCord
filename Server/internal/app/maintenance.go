package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
)

// maintenance is one pass's dependencies.
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
	// backupDir is backup.dir as configured (empty = data/backups).
	backupDir           string
	dbFile              string
	reportRetentionDays int
	actionRetentionDays int
	push                *service.PushService
	// linkPreviews is the shared thumbnail store the sweep trims, set by startMaintenanceLoop; nil when
	// its folder could not be made.
	linkPreviews        *linkpreview.Store
	linkPreviewCapBytes int64
	linkPreviewUnused   time.Duration
	// attention records each step's outcome for the admin panel; nil-safe.
	attention *service.AttentionService
	// erasureCtx is cancelled when the loop is told to stop, so a resumed
	// erasure drain ends between chunks and the queued job resumes at next
	// start. Nil: no cancellation.
	erasureCtx context.Context
	// stepsOverride replaces steps() when non-nil; a test seam.
	stepsOverride []maintenanceStep
	// holdLoggedUntil is the end of the restore hold last written to the log, so
	// a hold is announced once and not on every pass. Only the loop touches it.
	holdLoggedUntil time.Time
}

// maintenanceStep is one sweep: job is its attention-panel name, failLog the
// warning logged when run fails.
type maintenanceStep struct {
	job     string
	failLog string
	run     func(ctx context.Context) error
}

// newMaintenance builds the pass over the services; a nil svc (tests) skips
// every service-backed step.
func newMaintenance(log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services, files *storage.Storage) *maintenance {
	m := &maintenance{
		log: log, database: database,
		backupDir:           cfg.Backup.Dir,
		dbFile:              cfg.Database.Path,
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
	m.linkPreviewCapBytes = int64(cfg.LinkPreviews.ThumbnailCacheMB) << 20
	m.linkPreviewUnused = time.Duration(cfg.LinkPreviews.ThumbnailUnusedDays) * 24 * time.Hour
	// files is the upload store StartRuntime shares; it already holds the
	// erasure and retention runners' file remover (wireAuth), so no setter runs
	// after the hub started.
	if files == nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled")
		return m
	}
	m.files = files
	return m
}

// startMaintenanceLoop starts the periodic loop and returns the stop step the
// stage registers with App.Close.
func startMaintenanceLoop(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services, files *storage.Storage, previews *linkpreview.Store) func() {
	m := newMaintenance(log, cfg, database, svc, files)
	m.linkPreviews = previews
	erasureCtx, cancelErasure := context.WithCancel(bgCtx)
	m.erasureCtx = erasureCtx
	stop := runMaintenanceLoop(bgCtx, log, m)
	return func() {
		cancelErasure()
		stop()
	}
}

func runMaintenanceLoop(bgCtx context.Context, log *slog.Logger, m *maintenance) func() {
	for _, step := range m.steps() {
		m.attention.RegisterJob(step.job, step.failLog)
	}

	// Own context so the stop step can cancel an in-flight tick before its bounded join.
	loopCtx, cancelLoop := context.WithCancel(context.WithoutCancel(bgCtx))
	stopMaintenance := make(chan struct{})
	maintenanceDone := make(chan struct{})
	go m.loop(loopCtx, stopMaintenance, maintenanceDone)

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
		// Bounded join, so an in-flight tick is not using the database when Close tears it down.
		cancelLoop()
		close(stopMaintenance)
		select {
		case <-maintenanceDone:
		case <-time.After(5 * time.Second):
			log.Warn("maintenance loop did not exit before shutdown timeout")
		}
	}
}

func (m *maintenance) loop(bgCtx context.Context, stopMaintenance, maintenanceDone chan struct{}) {
	defer close(maintenanceDone)
	_ = m.runJob(bgCtx, "Account erasure")
	// reconcileOrphanedVoiceMutes deliberately does not run here: ClearAllVoiceStates already wiped the rows.
	_ = m.runJob(bgCtx, "Storage recount")
	_ = m.runJob(bgCtx, "Push subscriptions")
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	// An erasure that outran its inline budget, or failed after its lock, asks
	// for a resume now. A nil channel never fires.
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

// steps is the pass, in order. Voice mute reconciliation precedes action
// retention so a mute owner is released before its row can be retired.
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
		{job: "Link preview thumbnails", failLog: "link preview thumbnail sweep failed", run: m.sweepLinkPreviews},
		{job: "Message retention", failLog: "retention sweep failed", run: m.sweepRetention},
		{job: "Report content retention", failLog: "report content retention failed", run: m.pruneReportContent},
		{job: "Voice mute reconciliation", failLog: "orphaned voice mute reconciliation failed", run: m.reconcileOrphanedVoiceMutes},
		{job: "Moderation action retention", failLog: "moderation action retention failed", run: m.retireModerationActions},
		{job: "Account erasure", failLog: "erasure jobs still pending", run: m.resumeErasure},
		{job: "Storage reconciliation", failLog: "storage reconciliation failed", run: m.reconcileFiles},
		// Last on purpose: every sweep above that deletes attachment rows has run.
		{job: "Storage recount", failLog: "storage recount failed", run: m.recountStorage},
	}
}

func (m *maintenance) tick(ctx context.Context) bool {
	failed := false
	for _, step := range m.steps() {
		// Once the loop is cancelled (shutdown), remaining steps would only do
		// wasted work.
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
// failure.
func (m *maintenance) runStep(ctx context.Context, step maintenanceStep) error {
	err := step.run(ctx)
	m.attention.RecordJob(step.job, err, time.Now())
	if step.job == service.AttentionBackupJob && ctx.Err() == nil {
		m.attention.RefreshBackup(ctx, time.Now())
	}
	// A step cut short by shutdown cancelling its context is not a failure.
	if err != nil && ctx.Err() == nil {
		m.log.Warn(step.failLog, "error", err)
	}
	return err
}

// runJob runs the step named job outside a tick, so its outcome reaches the
// attention panel at once.
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

func (m *maintenance) sweepSecondFactor(ctx context.Context) error {
	return m.database.CleanupExpiredSecondFactorState(ctx)
}

// sweepPushSubscriptions removes stale Web Push subscriptions and every one a
// VAPID key rotation orphaned; a nil push is a no-op.
func (m *maintenance) sweepPushSubscriptions(ctx context.Context) error {
	if m.push == nil {
		return nil
	}
	_, err := m.push.Sweep(ctx)
	return err
}

// maintainBackups runs scheduled backups and retention pruning from the
// backup_schedule / backup_retention settings; with no settings service it
// skips.
func (m *maintenance) maintainBackups(ctx context.Context) error {
	if m.settings == nil {
		return nil
	}
	return admin.MaintainBackups(ctx, m.database, m.settings, admin.ResolveBackupDir(m.backupDir), m.dbFile)
}

// deletedAttachmentGrace is how long a deleted message's files stay on disk
// before the orphan sweep removes them.
const deletedAttachmentGrace = time.Hour

// sweepOrphans cleans up attachments never linked to a message (older than
// service.StagedUploadLifetime) and the files of deleted messages after
// deletedAttachmentGrace. Skipped with no file storage: the returned stored_as names are the only handle on
// the blobs.
func (m *maintenance) sweepOrphans(ctx context.Context) error {
	if m.files == nil {
		return nil
	}
	now := time.Now()
	// On error, names of rows already deleted still come back; their files are removed first.
	orphanFiles, err := m.database.DeleteOrphanedAttachmentsBefore(ctx, now.Add(-service.StagedUploadLifetime), now.Add(-deletedAttachmentGrace))
	for _, filename := range orphanFiles {
		if delErr := m.files.Delete(filename); delErr != nil {
			m.log.Warn("failed to delete orphan file", "file", filename, "error", delErr)
		}
	}
	if len(orphanFiles) > 0 {
		m.log.Info("cleaned up orphaned attachments", "count", len(orphanFiles))
	}
	if err != nil {
		return fmt.Errorf("sweep orphans: %w", err)
	}
	return nil
}

// sweepLinkPreviews trims the link preview thumbnails to link_previews.thumbnail_cache_mb and
// link_previews.thumbnail_unused_days. It runs whether or not link_previews.enabled is set, so
// turning the feature off reclaims disk down to the cap.
func (m *maintenance) sweepLinkPreviews(ctx context.Context) error {
	if m.linkPreviews == nil {
		return nil
	}
	res, err := m.linkPreviews.Sweep(ctx, m.linkPreviewCapBytes, m.linkPreviewUnused)
	if res.Images+res.Strays+res.Temps > 0 {
		m.log.Info("link preview thumbnails trimmed", "images", res.Images, "bytes", res.ImageBytes, "strays", res.Strays, "temps", res.Temps)
	}
	if err != nil {
		return fmt.Errorf("sweep link previews: %w", err)
	}
	return nil
}

// sweepRetention runs one bounded retention sweep per tick over every channel
// with an effective window.
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

// pruneReportContent deletes evidence and notes and clears the detail of
// reports closed longer ago than moderation.report_retention_days (default 180,
// 0 = never); the reports row is kept.
func (m *maintenance) pruneReportContent(ctx context.Context) error {
	if m.reports == nil || m.reportRetentionDays <= 0 {
		return nil
	}
	return m.reports.PruneClosedContent(ctx, time.Duration(m.reportRetentionDays)*24*time.Hour)
}

// retireModerationActions applies moderation.action_retention_days (default 90,
// 0 = never) right after report content retention
// (TestMaintenance_StepOrderIsPinned): warning rows retire after
// acknowledged_at, timeout rows after expires_at/lifted_at; ban, kick and
// removal rows are never touched.
func (m *maintenance) retireModerationActions(ctx context.Context) error {
	if m.actionRetentionDays <= 0 {
		return nil
	}
	_, err := m.database.RetireModerationActions(ctx, m.actionRetentionDays)
	return err
}

// reconcileOrphanedVoiceMutes gives every voice_states row whose
// server_muted_by points at a lifted or expired timeout the post-commit
// finalize a normal lift runs (actor 0, the system). Tick-only, because
// initDatabase wipes every row at loop start.
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

// resumeErasure runs every unfinished erasure job once, at loop start and every
// tick.
func (m *maintenance) resumeErasure(ctx context.Context) error {
	if m.erasure == nil {
		return nil
	}
	if m.erasureCtx != nil {
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

// reconcileFiles removes upload files no row names, which the orphan sweep
// strands when it stops between its DELETE and its unlinks or a restore leaves
// behind. It stands down while a recent restore's safety copy exists.
func (m *maintenance) reconcileFiles(ctx context.Context) error {
	if m.erasure == nil || m.files == nil {
		return nil
	}
	// A recent restore left a safety copy whose uploads the restored database
	// does not know: leave them until it has aged out (see restoreFileHold).
	now := time.Now()
	if m.restoreHoldsReclaim(now) {
		return nil
	}
	removed, err := m.erasure.Reconcile(ctx, m.files, now.Add(-1*time.Hour), reconcileFilesPerTick)
	if err != nil {
		return err
	}
	if removed > 0 {
		m.log.Info("storage reconciliation removed stranded files", "count", removed)
	}
	return nil
}

// recountStorage sets every per-user upload byte counter to the rows naming the
// user's files plus what is in flight; erasure, retention and the orphan sweep
// return bytes here.
func (m *maintenance) recountStorage(ctx context.Context) error {
	if m.uploads == nil {
		return nil
	}
	_, err := m.uploads.RecountStorage(ctx)
	return err
}

// restoreHoldsReclaim reports whether this pass must stand down, and logs why: once
// per hold for a fresh safety copy, on every pass for a folder it cannot read.
func (m *maintenance) restoreHoldsReclaim(now time.Time) bool {
	held, until, err := restoreHoldActive(admin.ResolveBackupDir(m.backupDir), now)
	switch {
	case err != nil:
		m.log.Warn("storage reconciliation skipped: backup folder could not be read", "err", err)
	case held && !until.Equal(m.holdLoggedUntil):
		m.holdLoggedUntil = until
		m.log.Info("storage reconciliation skipped while a restore safety copy is fresh", "until", until.UTC().Format(time.RFC3339))
	}
	return held
}

// reconcileFilesPerTick bounds how many stranded files one tick removes.
const reconcileFilesPerTick = 500
