package ws

import (
	"context"
	"log/slog"
	"sync/atomic"

	"github.com/J3vb/OwnCord/Server/db"
)

// reconnectSelectReplay picks the tier that serves this resume (ring buffer if it covers
// lastSeq, else the cold-tier EventStore) and returns the events, the tier name and, cold
// tier only, the persisted rows plus their highest seq for reconnectRegister's re-read. Nil
// events means neither tier can replay.
func (h *Hub) reconnectSelectReplay(
	ctx context.Context, c *Client, lastSeq uint64, allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool,
) ([][]byte, string, [][]byte, uint64) {
	var (
		events          [][]byte
		replaySource    = "buffer"
		persistedTail   [][]byte // cold-tier rows only; re-merged with a fresh buffer tail below
		maxPersistedSeq uint64
	)
	if buf := h.ReplayBuffer().EventsSinceFilteredContent(lastSeq, allowedChannelIDs, nsfwReadableChannelIDs); buf != nil {
		events = buf
		return events, replaySource, persistedTail, maxPersistedSeq
	}
	h.noteRingMiss(lastSeq)
	if esp := h.events.eventStore.Load(); esp != nil {
		es := *esp
		channelIDs := make([]int64, 0, len(allowedChannelIDs))
		for cid := range allowedChannelIDs {
			channelIDs = append(channelIDs, cid)
		}
		coldCap := h.maxColdReplayLimit()
		persisted, dbErr := es.GetEventsSinceForChannels(ctx, int64(lastSeq), channelIDs, coldCap) //nolint:gosec // lastSeq is a sequence counter bounded well below MaxInt64
		switch {
		case dbErr != nil:
			slog.Warn("ws handleReconnect: cold-tier replay query failed",
				"user_id", c.userID, "err", dbErr)
		case len(persisted) >= coldCap:
			// The query is ORDER BY seq ASC LIMIT maxColdReplay, so a full result means the gap exceeds
			// the cap and the newest events were dropped. Replaying it would look like a complete
			// resume (the client tracks only max(seq)) and silently lose state events REST never
			// repairs: leave events nil to force a full ready.
			slog.Warn("ws handleReconnect: cold-tier replay hit the row cap, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq, "cap", coldCap)
		case len(persisted) > 0:
			// Retention pruning deletes by created_at with no seq-floor coordination, so this
			// channel-filtered result can be a surviving suffix that presents a hole as a complete
			// resume. Probe the store's oldest surviving seq unfiltered: a contiguity check on persisted
			// cannot work since a sparse per-channel result is legitimately non-contiguous.
			oldest, oldestErr := es.GetEventsSince(ctx, 0, 1)
			switch {
			case oldestErr != nil:
				slog.Warn("ws handleReconnect: cold-tier oldest-seq probe failed, forcing full ready",
					"user_id", c.userID, "err", oldestErr)
			case len(oldest) == 0 || uint64(oldest[0].Seq) > lastSeq+1: //nolint:gosec // seq is a counter bounded well below MaxInt64
				var oldestSeq int64
				if len(oldest) > 0 {
					oldestSeq = oldest[0].Seq
				}
				slog.Warn("ws handleReconnect: retention pruning left a gap before last_seq, forcing full ready",
					"user_id", c.userID, "last_seq", lastSeq, "oldest_seq", oldestSeq)
			default:
				persistedTail, maxPersistedSeq = h.reconnectVetColdTail(ctx, c, es, lastSeq, persisted, allowedChannelIDs, nsfwReadableChannelIDs)
				if persistedTail != nil {
					events = persistedTail
					replaySource = "db"
				}
			}
		}
	}
	return events, replaySource, persistedTail, maxPersistedSeq
}

// reconnectVetColdTail turns a cold-tier result into a replayable tail, or nil when it
// cannot be trusted: no interior gap, and the ring buffer must cover everything newer than
// its last row. The returned seq is the highest in persisted.
func (h *Hub) reconnectVetColdTail(
	ctx context.Context, c *Client, es EventStore, lastSeq uint64,
	persisted []db.PersistedEvent, allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool,
) ([][]byte, uint64) {
	// A content-bearing row for an allowed but unreadable (labelled, unacknowledged) channel is
	// dropped, as EventsSinceFilteredContent does for the ring buffer. Checked against the
	// row's stored EventType/ChannelID, not its payload.
	persistedTail := make([][]byte, 0, len(persisted))
	for _, p := range persisted {
		if contentBearingKinds[p.EventType] && !nsfwReadableChannelIDs[p.ChannelID] {
			continue
		}
		persistedTail = append(persistedTail, p.Payload)
	}
	maxPersistedSeq := uint64(persisted[len(persisted)-1].Seq) //nolint:gosec // seq is a counter bounded well below MaxInt64

	// persisted is channel-filtered, so a hole in a channel outside allowedChannelIDs would slip
	// past a contiguity check on it, and EventPersister can lose a row (a full queue drops
	// silently; a per-row batch insert failure is only logged). Count the unfiltered range
	// (lastSeq, maxPersistedSeq] and require every seq present; seq is the primary key so the
	// count can only come up short.
	expectedCount := maxPersistedSeq - lastSeq
	switch gapCount, gapErr := es.CountEventsInRange(ctx, int64(lastSeq), int64(maxPersistedSeq)); { //nolint:gosec // bounded well below MaxInt64
	case gapErr != nil:
		slog.Warn("ws handleReconnect: cold-tier contiguity probe failed, forcing full ready",
			"user_id", c.userID, "err", gapErr)
		persistedTail = nil
	case uint64(gapCount) != expectedCount: //nolint:gosec // bounded well below MaxInt64
		slog.Warn("ws handleReconnect: cold-tier replay has an interior gap, forcing full ready",
			"user_id", c.userID, "last_seq", lastSeq, "max_persisted_seq", maxPersistedSeq,
			"expected", expectedCount, "found", gapCount)
		persistedTail = nil
	}

	if persistedTail != nil {
		// EventPersister flushes asynchronously, so newer events may sit only in the ring buffer. Confirm the
		// buffer covers everything above the newest persisted row; a hole must force a full ready, not a
		// replay with a silent gap at its end (the authoritative re-read is atomic with registerNow).
		switch tail := h.ReplayBuffer().EventsSinceFilteredContent(maxPersistedSeq, allowedChannelIDs, nsfwReadableChannelIDs); {
		case tail != nil:
		case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
			// Post-restart empty buffer with the hub seq seeded from the store max: nothing was broadcast
			// after the last persisted row.
		default:
			slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail, forcing full ready",
				"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
			persistedTail = nil
		}
	}
	return persistedTail, maxPersistedSeq
}
