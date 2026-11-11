package app

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/ws"
)

// startEventPersister starts the persister and pruner, returning (nil, nil)
// when persistence is disabled. seedHubReplayState runs whenever hub is
// non-nil, so ring-buffer-only mode still gets a seq floor.
func startEventPersister(bgCtx context.Context, log *slog.Logger, cfg *config.Config, hub *ws.Hub, database *db.DB) (*ws.EventPersister, <-chan struct{}) {
	if hub == nil {
		return nil, nil
	}

	seedHubReplayState(bgCtx, hub, database, log)

	if !cfg.EventPersistence.Enabled {
		return nil, nil
	}

	persister := ws.NewEventPersister(
		database,
		4096,
		cfg.EventPersistence.BatchSize,
		time.Duration(cfg.EventPersistence.BatchFlushMs)*time.Millisecond,
	)
	persister.Start(bgCtx)
	hub.SetEventPersister(persister)
	hub.SetEventStore(database)

	retention := time.Duration(cfg.EventPersistence.RetentionHours) * time.Hour
	prunerInterval := time.Duration(cfg.EventPersistence.PrunerIntervalMinutes) * time.Minute
	prunerDone := ws.StartEventPruner(bgCtx, database, retention, prunerInterval)

	return persister, prunerDone
}

// stopEventPersister drains the persister and pruner. A nil persister is the
// disabled case and must leave bgCtx alone; ctx is the step's budget, which the
// 5s cap sits within.
func stopEventPersister(ctx context.Context, log *slog.Logger, bgCancel context.CancelFunc, persister *ws.EventPersister, prunerDone <-chan struct{}) {
	if persister == nil {
		return
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	persister.Stop(stopCtx)
	// Cancel bgCtx and join the pruner before database.Close, so no prune runs against a closing pool.
	bgCancel()
	select {
	case <-prunerDone:
	case <-stopCtx.Done():
		log.Warn("event pruner did not exit before shutdown timeout")
	}
}

// newAuditWriter installs the async audit writer, moving audit INSERTs off the
// request path. Paths that install none (the token CLI, tests) stay
// synchronous.
func newAuditWriter(bgCtx context.Context, database *db.DB) *db.AuditWriter {
	auditWriter := db.NewAuditWriter(database, 1024, 50, 100*time.Millisecond)
	auditWriter.Start(bgCtx)
	database.SetAuditWriter(auditWriter)

	return auditWriter
}

// stopAuditWriter drains the async audit writer within the step's budget.
func stopAuditWriter(ctx context.Context, auditWriter *db.AuditWriter) {
	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	auditWriter.Stop(stopCtx)
}

const wsSeqFloorSettingKey = db.WSSeqFloorSettingKey

// wsSeqFloorReserve is the block reserved above the persisted floor each boot;
// it only has to exceed one boot's hub-sequenced broadcasts, and 1e9 leaves a
// huge margin before uint64 could wrap.
const wsSeqFloorReserve = db.WSSeqFloorReserve

// seedHubReplayState seeds the hub's seq counter at startup from two sources
// via hub.SeedSeq, which only moves the counter forward (CAS-max), so order
// does not matter: 1. seedHubSeqFloor reserves a fresh block of seq space on
// every boot, with or without persistence. 2. With persistence and history, MAX(events.seq) wins if
// higher; this branch also forces visibilityChangeSeq forward via MarkVisibilityChanged: that in-memory
// watermark starts at 0 on a fresh process, and visibility changes to an
// offline client are unsequenced and never written to events, so without it a
// client resuming before the pre-restart max could miss one (ws/hub_events.go
// mustFullResync).
func seedHubReplayState(ctx context.Context, hub *ws.Hub, database *db.DB, log *slog.Logger) {
	seedHubSeqFloor(ctx, hub, database, log)

	maxSeq, seedErr := database.GetMaxEventSeq(ctx)
	if seedErr != nil {
		log.Warn("event persistence: failed to read MAX(events.seq); hub seq still advanced from the persisted floor for this boot", "error", seedErr)
		return
	}
	if maxSeq <= 0 {
		return
	}
	hub.SeedSeq(uint64(maxSeq))
	log.Info("event persistence: seeded hub seq from persisted events", "seq", maxSeq)
	hub.MarkVisibilityChanged()
}

// seedHubSeqFloor reserves and persists a fresh block of seq space on every
// boot.
func seedHubSeqFloor(ctx context.Context, hub *ws.Hub, database *db.DB, log *slog.Logger) {
	var floor uint64
	settingsReadable := true
	raw, err := database.GetSetting(ctx, wsSeqFloorSettingKey)
	switch {
	case err == nil:
		parsed, perr := strconv.ParseUint(raw, 10, 64)
		if perr != nil {
			log.Warn("event persistence: stored ws seq floor is not a valid uint64, resetting to 0", "value", raw, "error", perr)
			break
		}
		if parsed > db.MaxWSSeqFloor {
			log.Error("event persistence: stored ws seq floor is above the limit, using the limit", "value", raw)
			parsed = db.MaxWSSeqFloor
		}
		floor = parsed
	case errors.Is(err, db.ErrNotFound):
	default:
		log.Warn("event persistence: failed to read persisted ws seq floor", "error", err)
		settingsReadable = false
	}

	// The sidecar survives a backup restore; max keeps this boot above any pre-restore seq (forces resync).
	sidecar, ok, serr := database.WSSeqFloorSidecar()
	if serr != nil {
		log.Warn("event persistence: ws seq floor sidecar unreadable; using the settings value", "error", serr)
	}
	if ok {
		floor = max(floor, sidecar)
	}
	if !settingsReadable && !ok {
		return
	}

	newFloor := floor + wsSeqFloorReserve
	if newFloor > db.MaxWSSeqFloor {
		log.Error("event persistence: ws seq floor reached its limit, keeping the limit", "floor", floor)
		newFloor = db.MaxWSSeqFloor
	}
	// Sidecar first, so a failed settings write still leaves the block recorded.
	sidecarErr := database.StoreWSSeqFloorSidecar(newFloor)
	if sidecarErr != nil {
		log.Warn("event persistence: failed to persist ws seq floor sidecar", "error", sidecarErr)
	}
	settingsErr := database.SetSetting(ctx, wsSeqFloorSettingKey, strconv.FormatUint(newFloor, 10))
	if settingsErr != nil {
		log.Warn("event persistence: failed to persist advanced ws seq floor", "error", settingsErr)
	}
	if sidecarErr != nil && settingsErr != nil {
		return
	}
	hub.SeedSeq(newFloor)
}
