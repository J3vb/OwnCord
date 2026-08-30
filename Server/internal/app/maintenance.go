package app

import (
	"context"
	"log/slog"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/storage"
)

// runStartMaintenance starts the periodic maintenance loop and returns the
// stop step run defers. Extracted from run.
func runStartMaintenance(bgCtx context.Context, log *slog.Logger, cfg *config.Config, database *db.DB) func() {
	// Periodically purge expired sessions and orphaned attachments.
	fileStorage, fileStorageErr := storage.New(cfg.Upload.StorageDir, cfg.Upload.MaxSizeMB)
	if fileStorageErr != nil {
		log.Warn("failed to create file storage for maintenance; orphan file cleanup disabled", "error", fileStorageErr)
	}

	stopMaintenance := make(chan struct{})
	maintenanceDone := make(chan struct{})
	go runMaintenanceLoop(bgCtx, log, database, fileStorage, stopMaintenance, maintenanceDone)

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

// runMaintenanceLoop is the periodic maintenance goroutine started by
// runStartMaintenance. Extracted from run.
func runMaintenanceLoop(bgCtx context.Context, log *slog.Logger, database *db.DB, fileStorage *storage.Storage, stopMaintenance, maintenanceDone chan struct{}) {
	defer close(maintenanceDone)
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()
	consecutiveFailures := 0
	const maxConsecutiveFailures = 5
	for {
		select {
		case <-ticker.C:
			if consecutiveFailures >= maxConsecutiveFailures {
				log.Error("maintenance loop: circuit breaker open, skipping tick",
					"consecutive_failures", consecutiveFailures)
				// Reset after one skip to allow retry next tick.
				consecutiveFailures = maxConsecutiveFailures - 1
				continue
			}

			if runMaintenanceTick(bgCtx, log, database, fileStorage) {
				consecutiveFailures++
			} else {
				consecutiveFailures = 0
			}
		case <-stopMaintenance:
			return
		}
	}
}

// runMaintenanceTick runs one maintenance pass and reports whether any step
// of it failed. Extracted from run.
func runMaintenanceTick(bgCtx context.Context, log *slog.Logger, database *db.DB, fileStorage *storage.Storage) bool {
	tickFailed := false
	if err := database.DeleteExpiredSessions(bgCtx); err != nil {
		log.Warn("failed to delete expired sessions", "error", err)
		tickFailed = true
	}

	// Scheduled backups + retention pruning, driven by the
	// backup_schedule / backup_retention admin settings.
	if err := admin.MaintainBackups(bgCtx, database); err != nil {
		log.Warn("backup maintenance failed", "error", err)
		tickFailed = true
	}

	// Clean up orphaned attachments (uploaded but never linked to a message).
	//
	// Skipped entirely with no file storage configured: the delete is
	// atomic (row goes the instant it's selected, by design — see
	// db/attachment_queries.go), so with fileStorage nil the returned
	// stored_as names — the only remaining handle on those blobs —
	// would just be discarded and the files stranded on disk with no
	// query left able to name them. Leaving the rows in place keeps
	// them reclaimable once storage is available again.
	if fileStorage != nil {
		cutoff := time.Now().Add(-1 * time.Hour)
		orphanFiles, orphanErr := database.DeleteOrphanedAttachments(bgCtx, cutoff)
		if orphanErr != nil {
			log.Warn("failed to delete orphaned attachments", "error", orphanErr)
			tickFailed = true
		} else if len(orphanFiles) > 0 {
			// Best-effort file cleanup.
			for _, filename := range orphanFiles {
				if delErr := fileStorage.Delete(filename); delErr != nil {
					log.Warn("failed to delete orphan file", "file", filename, "error", delErr)
				}
			}
			log.Info("cleaned up orphaned attachments", "count", len(orphanFiles))
		}
	}

	return tickFailed
}
