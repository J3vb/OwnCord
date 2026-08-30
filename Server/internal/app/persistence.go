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

// startEventPersister starts the event persister and pruner, returning
// both as (nil, nil) when event persistence is disabled.
//
// seedHubReplayState runs unconditionally (whenever hub is non-nil), NOT
// gated on cfg.EventPersistence.Enabled: it seeds the hub's seq counter from
// a persisted floor even in ring-buffer-only mode, which is what closes
// OC-0210 — see its doc comment.
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

// stopEventPersister drains the event persister and pruner. Registered
// unconditionally, so a nil persister is the disabled case and must leave
// bgCtx alone — Run's backstop close step cancels it instead. ctx is
// App.Close's shutdown budget; the 5s cap is this step's share of it.
func stopEventPersister(ctx context.Context, log *slog.Logger, bgCancel context.CancelFunc, persister *ws.EventPersister, prunerDone <-chan struct{}) {
	if persister == nil {
		return
	}

	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	persister.Stop(stopCtx)
	// Cancel the shared background context and JOIN the pruner before
	// the (LIFO-later) database.Close defer runs, so no prune is still
	// mid-query against a closing pool. Bounded: a stuck prune delays
	// shutdown by at most the timeout, then Close proceeds anyway.
	bgCancel()
	select {
	case <-prunerDone:
	case <-stopCtx.Done():
		log.Warn("event pruner did not exit before shutdown timeout")
	}
}

// newAuditWriter installs the async audit writer: audit-log INSERTs move off
// the request path, and a background goroutine batches the writes. Paths that
// never install a writer — the token CLI, tests — keep the synchronous
// behaviour. It starts after the database opens, so App.Close drains its
// queue while the handle is still live.
func newAuditWriter(bgCtx context.Context, database *db.DB) *db.AuditWriter {
	auditWriter := db.NewAuditWriter(database, 1024, 50, 100*time.Millisecond)
	auditWriter.Start(bgCtx)
	database.SetAuditWriter(auditWriter)

	return auditWriter
}

// stopAuditWriter drains the async audit writer, within its share of
// App.Close's shutdown budget.
func stopAuditWriter(ctx context.Context, auditWriter *db.AuditWriter) {
	stopCtx, stopCancel := context.WithTimeout(ctx, 5*time.Second)
	defer stopCancel()
	auditWriter.Stop(stopCtx)
}

// wsSeqFloorSettingKey is the generic settings-table key (see db.GetSetting /
// db.SetSetting) seedHubSeqFloor persists its reserved floor under.
const wsSeqFloorSettingKey = "ws_seq_floor"

// wsSeqFloorReserve is the block seedHubSeqFloor reserves above the persisted
// floor on every single boot (OC-0210). It only has to exceed the number of
// hub-sequenced broadcasts any one boot could plausibly emit before its own
// next restart — comfortably true at 1e9 for a self-hosted chat server — so
// this leaves an enormous safety margin while uint64's range still allows
// billions of restarts before the floor could ever wrap.
const wsSeqFloorReserve = 1_000_000_000

// seedHubReplayState seeds the hub's monotonic seq counter at startup from
// two independent, composable sources — both go through hub.SeedSeq, which
// only ever moves h.seq forward (CAS-max), so it doesn't matter which of the
// two runs first or whether either is available:
//
//  1. seedHubSeqFloor (below) reserves and persists a fresh block of seq
//     space on every boot, regardless of whether event persistence is
//     enabled. This is what closes OC-0210: previously this function did
//     nothing at all when event_persistence.enabled is false (the
//     documented "ring-buffer-only behaviour", config.go's
//     EventPersistenceConfig.Enabled), so every boot's h.seq — and
//     therefore its ring buffer's first entries — started back at 0/1. A
//     client reconnecting with a last_seq remembered from a PRIOR boot
//     could then coincidentally land inside the new boot's own live ring
//     window: EventRingBuffer.EventsSinceFiltered has no way to tell that
//     watermark apart from a legitimate one from this boot, and would
//     silently serve a partial cross-epoch replay as if it were an
//     ordinary resume. Seeding a floor far above anything a single boot
//     could reach guarantees every previous boot's real seq values now sit
//     below the new ring buffer's oldest entry, so a stale last_seq is
//     correctly rejected by the pre-existing "afterSeq <= oldestSeq" guard
//     in ringbuffer.go and falls through to a full ready instead
//     (serve.go's handleReconnect, the `events == nil` branch) — the same
//     path any other unrecoverable resume already takes, with no protocol
//     change required.
//  2. When event persistence is enabled and the events table has history,
//     MAX(events.seq) is exact (not a heuristic reserve) and naturally
//     wins if it is the higher of the two. This branch is also what forces
//     the paired visibilityChangeSeq watermark forward via
//     MarkVisibilityChanged: h.seq is restored here, but the watermark
//     that tells a resuming client whether a channel-visibility change
//     happened since its last_seq (visibilityChangeSeq) is in-memory only
//     and always starts at 0 on a fresh process — see
//     ws/hub_events.go's mustFullResync. Channel-visibility changes made to
//     an offline client (RefreshChannelVisibility, revokeUnreadableChannels)
//     are sent as targeted, unsequenced messages that are never written to
//     the events table, so replay can never recover them. Without the
//     MarkVisibilityChanged call below, a client resuming with last_seq at
//     or before the pre-restart max would sail straight through
//     mustFullResync's zeroed watermark and could silently miss a
//     visibility change it should have converged on.
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
// space on every boot, independent of event persistence (OC-0210) — see
// seedHubReplayState's doc for why this is what actually closes the bug. A
// read or write failure against the settings table is logged and skipped
// rather than fatal: it leaves this one boot with the pre-fix exposure
// (plain Phase A ring-buffer behaviour) instead of blocking startup over a
// heuristic safety net.
func seedHubSeqFloor(ctx context.Context, hub *ws.Hub, database *db.DB, log *slog.Logger) {
	var floor uint64
	raw, err := database.GetSetting(ctx, wsSeqFloorSettingKey)
	switch {
	case err == nil:
		parsed, perr := strconv.ParseUint(raw, 10, 64)
		if perr != nil {
			log.Warn("event persistence: stored ws seq floor is not a valid uint64, resetting to 0", "value", raw, "error", perr)
			break
		}
		floor = parsed
	case errors.Is(err, db.ErrNotFound):
		// No prior boot has ever reserved a floor — start from 0.
	default:
		log.Warn("event persistence: failed to read persisted ws seq floor; hub seq not advanced this boot", "error", err)
		return
	}

	newFloor := floor + wsSeqFloorReserve
	if err := database.SetSetting(ctx, wsSeqFloorSettingKey, strconv.FormatUint(newFloor, 10)); err != nil {
		log.Warn("event persistence: failed to persist advanced ws seq floor; hub seq not advanced this boot", "error", err)
		return
	}
	hub.SeedSeq(newFloor)
}
