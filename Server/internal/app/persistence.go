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

// startEventPersister starts the event persister and pruner, returning both as
// (nil, nil) when event persistence is disabled.
//
// seedHubReplayState runs whenever hub is non-nil, not only when persistence
// is enabled: it seeds the hub's seq counter from a persisted floor even in
// ring-buffer-only mode.
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

// stopEventPersister drains the event persister and pruner. A nil persister is
// the disabled case and must leave bgCtx alone; Run's backstop close step
// cancels it. ctx is the event-persistence step's App.Close budget, which the
// 5s cap sits within.
func stopEventPersister(ctx context.Context, log *slog.Logger, bgCancel context.CancelFunc, persister *ws.EventPersister, prunerDone <-chan struct{}) {
	if persister == nil {
		return
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	persister.Stop(stopCtx)
	// Cancel the shared background context and join the pruner before the
	// later database.Close, so no prune is mid-query against a closing pool.
	// Bounded: a stuck prune delays shutdown by at most the timeout.
	bgCancel()
	select {
	case <-prunerDone:
	case <-stopCtx.Done():
		log.Warn("event pruner did not exit before shutdown timeout")
	}
}

// newAuditWriter installs the async audit writer: audit-log INSERTs move off
// the request path into a batching goroutine. Paths that never install one
// (the token CLI, tests) stay synchronous. It starts after the database opens,
// so App.Close drains its queue while the handle is live.
func newAuditWriter(bgCtx context.Context, database *db.DB) *db.AuditWriter {
	auditWriter := db.NewAuditWriter(database, 1024, 50, 100*time.Millisecond)
	auditWriter.Start(bgCtx)
	database.SetAuditWriter(auditWriter)

	return auditWriter
}

// stopAuditWriter drains the async audit writer within the audit-writer step's
// App.Close budget.
func stopAuditWriter(ctx context.Context, auditWriter *db.AuditWriter) {
	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	auditWriter.Stop(stopCtx)
}

// wsSeqFloorSettingKey is the settings-table key seedHubSeqFloor persists its
// reserved floor under.
const wsSeqFloorSettingKey = db.WSSeqFloorSettingKey

// wsSeqFloorReserve is the block seedHubSeqFloor reserves above the persisted
// floor on every boot. It only has to exceed the hub-sequenced broadcasts one
// boot could emit before its next restart; 1e9 leaves a huge margin while
// uint64 still allows billions of restarts before the floor could wrap.
const wsSeqFloorReserve = db.WSSeqFloorReserve

// seedHubReplayState seeds the hub's monotonic seq counter at startup from two
// independent sources, both through hub.SeedSeq, which only moves h.seq
// forward (CAS-max), so their order and availability do not matter:
//
//  1. seedHubSeqFloor reserves and persists a fresh block of seq space on every
//     boot, whether or not event persistence is enabled. Without it a
//     ring-buffer-only boot restarted h.seq at 0/1, so a client reconnecting
//     with a last_seq from a prior boot could land inside the new boot's live
//     ring window, and EventRingBuffer.EventsSinceFiltered could not tell it
//     from a legitimate one and would serve a partial cross-epoch replay as an
//     ordinary resume. A floor far above anything one boot reaches puts every
//     earlier seq below the ring's oldest entry, so a stale last_seq is
//     rejected by the "afterSeq <= oldestSeq" guard in ringbuffer.go and falls
//     through to a full ready (serve.go handleReconnect, the `events == nil`
//     branch), with no protocol change.
//  2. When persistence is enabled and the events table has history,
//     MAX(events.seq) is exact and wins if it is higher. This branch also
//     forces the paired visibilityChangeSeq watermark forward via
//     MarkVisibilityChanged: that watermark (see ws/hub_events.go
//     mustFullResync) is in-memory only and starts at 0 on a fresh process, and
//     channel-visibility changes to an offline client (RefreshChannelVisibility,
//     revokeUnreadableChannels) are targeted, unsequenced messages never
//     written to the events table. Without the call, a client resuming at or
//     before the pre-restart max would pass mustFullResync's zeroed watermark
//     and could miss a visibility change.
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

// seedHubSeqFloor reserves and persists a fresh block of the hub's sequence
// space on every boot, independent of event persistence (see seedHubReplayState).
// A read or write failure against the settings table is logged, not fatal: the
// sidecar beside the database still carries the floor, and when neither copy
// can be written this boot keeps plain ring-buffer behaviour rather than block
// startup over a safety net.
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
		// No prior boot has reserved a floor: start from 0.
	default:
		log.Warn("event persistence: failed to read persisted ws seq floor", "error", err)
		settingsReadable = false
	}

	// The sidecar beside the database survives a backup restore, which rewinds
	// the settings copy to the backup's older value. Taking the max keeps this
	// boot's block above everything the pre-restore server could hand out, so a
	// pre-restore last_seq forces a full resync. A missing or damaged sidecar is
	// not fatal: the settings value seeds the block alone.
	sidecar, ok, serr := database.WSSeqFloorSidecar()
	if serr != nil {
		log.Warn("event persistence: ws seq floor sidecar unreadable; using the settings value", "error", serr)
	}
	if ok {
		floor = max(floor, sidecar)
	}
	if !settingsReadable && !ok {
		// Neither copy of the floor is known; leave the hub unseeded rather
		// than guess a value that could sit below an earlier block.
		return
	}

	// floor <= MaxWSSeqFloor, so the sum cannot wrap; it saturates at the limit.
	newFloor := floor + wsSeqFloorReserve
	if newFloor > db.MaxWSSeqFloor {
		log.Error("event persistence: ws seq floor reached its limit, keeping the limit", "floor", floor)
		newFloor = db.MaxWSSeqFloor
	}
	// Either durable copy keeps the next boot above this block, so the hub is
	// seeded when one write lands. Sidecar first so a failed settings write
	// still leaves the block recorded.
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
