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

// maintenance is one maintenance pass's dependencies. Every sweep is a step
// in steps(), run in that order by tick; a failing step is logged and counts
// toward the loop's circuit breaker, and the rest of the pass still runs. A
// new sweep is a method plus one row in steps() — B5-4 and B5-11 add theirs
// there rather than growing tick.
type maintenance struct {
	log       *slog.Logger
	database  *db.DB
	files     *storage.Storage
	settings  *service.SettingsService
	erasure   *service.ErasureService
	retention *service.RetentionService
	uploads   *service.UploadService
	reports   *service.ReportService
	// reportRetentionDays is moderation.report_retention_days (0 = never).
	reportRetentionDays int
	push                *service.PushService
}

// maintenanceStep is one sweep: name is the warning logged when run fails.
type maintenanceStep struct {
	name string
	run  func(ctx context.Context) error
}

// newMaintenance builds the pass over the composition root's services. svc
// may be nil (a partial wiring in tests), which leaves every service-backed
// step skipped.
func newMaintenance(log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services) *maintenance {
	m := &maintenance{log: log, database: database, reportRetentionDays: cfg.Moderation.ReportRetentionDays}
	if svc != nil {
		m.settings, m.erasure, m.retention, m.uploads = svc.Settings, svc.Erasure, svc.Retention, svc.Uploads
		m.reports = svc.Reports
		m.push = svc.Push
	}
	// Periodically purge expired sessions and orphaned attachments.
	files, err := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if err != nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled", "error", err)
		return m
	}
	m.files = files
	// The erasure runner removes files through whichever storage was
	// installed first (the router's, normally); this one is the fallback so
	// journaled jobs still finish when the upload routes did not mount.
	if m.erasure != nil && !m.erasure.HasFiles() {
		m.erasure.SetFiles(files)
	}
	if m.retention != nil {
		m.retention.SetFiles(files)
	}
	return m
}

// startMaintenanceLoop starts the periodic maintenance loop and returns the
// stop step the maintenance stage registers with App.Close.
func startMaintenanceLoop(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB, svc *service.Services) func() {
	m := newMaintenance(log, cfg, database, svc)

	stopMaintenance := make(chan struct{})
	maintenanceDone := make(chan struct{})
	go m.loop(bgCtx, stopMaintenance, maintenanceDone)

	return func() {
		// Backstop for early returns below (see hub.GracefulStop defer above),
		// and a bounded join so an in-flight tick (which can hold the writer —
		// scheduled backups run VACUUM INTO) isn't still using the database
		// while the LIFO-later Close defer tears it down.
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
	// yet removed) finish now, not fifteen minutes from now (B4-9).
	if err := m.resumeErasure(bgCtx); err != nil {
		m.log.Warn("erasure jobs still pending", "error", err)
	}
	// Storage counters charged by a process that died between the charge
	// and the write are settled now, so a restart is a repair point rather
	// than fifteen minutes of a user seeing a phantom charge (B5-2).
	if err := m.recountStorage(bgCtx); err != nil {
		m.log.Warn("storage recount failed", "error", err)
	}
	// A VAPID key rotation takes effect on the first boot with the new key,
	// not fifteen minutes later (B5-4): rows the rotation orphaned stop
	// being listed the instant the new key is installed, but the sweep is
	// what actually removes them.
	if err := m.sweepPushSubscriptions(bgCtx); err != nil {
		m.log.Warn("push subscription sweep failed", "error", err)
	}
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
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
		case <-stopMaintenance:
			return
		}
	}
}

// steps is the pass, in order. Later steps depend on earlier ones having
// run: the reconciliation pass at the end only sees what the orphan and
// retention sweeps stranded this tick.
func (m *maintenance) steps() []maintenanceStep {
	return []maintenanceStep{
		{"failed to delete expired sessions", m.sweepSessions},
		{"failed to clean up expired second-factor state", m.sweepSecondFactor},
		{"push subscription sweep failed", m.sweepPushSubscriptions},
		{"backup maintenance failed", m.maintainBackups},
		{"failed to delete orphaned attachments", m.sweepOrphans},
		{"retention sweep failed", m.sweepRetention},
		{"report content retention failed", m.pruneReportContent},
		{"erasure jobs still pending", m.resumeErasure},
		{"storage reconciliation failed", m.reconcileFiles},
		// Last on purpose: every sweep above that deletes attachment rows
		// (orphans, retention, erasure) has run, so this tick's recount
		// already returns the bytes they freed.
		{"storage recount failed", m.recountStorage},
	}
}

// tick runs one maintenance pass and reports whether any step of it failed.
func (m *maintenance) tick(ctx context.Context) bool {
	failed := false
	for _, step := range m.steps() {
		if err := step.run(ctx); err != nil {
			m.log.Warn(step.name, "error", err)
			failed = true
		}
	}
	return failed
}

func (m *maintenance) sweepSessions(ctx context.Context) error {
	return m.database.DeleteExpiredSessions(ctx)
}

// sweepSecondFactor removes expired login challenges, staged enrolments and
// spent TOTP codes (migration 032) — the persisted second-factor state's sweep.
func (m *maintenance) sweepSecondFactor(ctx context.Context) error {
	return m.database.CleanupExpiredSecondFactorState(ctx)
}

// sweepPushSubscriptions removes stale Web Push subscriptions and every
// subscription a VAPID key rotation orphaned (B5-4, decisions 2 and 5). Nil
// push means no service layer at all (a partial wiring in tests); a no-op
// tick is the point, not a failure.
func (m *maintenance) sweepPushSubscriptions(ctx context.Context) error {
	if m.push == nil {
		return nil
	}
	_, err := m.push.Sweep(ctx)
	return err
}

// maintainBackups runs scheduled backups and retention pruning, driven by the
// backup_schedule / backup_retention admin settings. No settings service
// means no schedule to read, so the step skips rather than dereferencing nil
// (admin.MaintainBackups reads the schedule through it unconditionally).
func (m *maintenance) maintainBackups(ctx context.Context) error {
	if m.settings == nil {
		return nil
	}
	return admin.MaintainBackups(ctx, m.database, m.settings)
}

// sweepOrphans cleans up orphaned attachments (uploaded but never linked to
// a message).
//
// Skipped entirely with no file storage configured: the delete is atomic
// (row goes the instant it's selected, by design — see
// db/attachment_queries.go), so with files nil the returned stored_as names
// — the only remaining handle on those blobs — would just be discarded and
// the files stranded on disk with no query left able to name them. Leaving
// the rows in place keeps them reclaimable once storage is available again.
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

// sweepRetention is message retention (B4-11): one bounded sweep per tick
// over every channel with an effective window; indefinite by default, so a
// server without a policy does nothing here.
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

// pruneReportContent is B5-8's retention step (moderation.report_retention_days,
// default 180, 0 = never): deletes the evidence and notes and clears the
// detail of every report closed longer ago than the window. The reports row
// itself is kept — content is bounded, the outcome is indefinite (S5-d).
func (m *maintenance) pruneReportContent(ctx context.Context) error {
	if m.reports == nil || m.reportRetentionDays <= 0 {
		return nil
	}
	return m.reports.PruneClosedContent(ctx, time.Duration(m.reportRetentionDays)*24*time.Hour)
}

// resumeErasure runs every unfinished erasure job once (no runner is a
// success: nothing to do). It runs at loop start and again every tick.
func (m *maintenance) resumeErasure(ctx context.Context) error {
	if m.erasure == nil {
		return nil
	}
	done, err := m.erasure.Resume(ctx)
	if done > 0 {
		m.log.Info("erasure jobs completed", "count", done)
	}
	return err
}

// reconcileFiles is the reconciliation pass: files in upload storage that no
// row names — what the orphan sweep strands when it stops between its DELETE
// and its unlinks (O3 A1), or a restore leaves behind (O3 A5) — bounded per
// tick and only past the same one-hour grace an in-flight upload gets.
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

// recountStorage sets every per-user upload byte counter to the rows that
// name the user's files plus what is still in flight (B5-2). It is the
// reconciliation decision 11 puts on the maintenance sweep: the counter is a
// cache of the rows, and this is where erasure, retention and the orphan
// sweep return bytes.
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
