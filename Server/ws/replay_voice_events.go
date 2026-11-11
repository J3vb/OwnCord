package ws

import (
	"context"
	"log/slog"
)

// liveVoiceEventsSinceCore is the ring-first / cold-fallback ladder shared by the
// liveVoiceEventsSince* supplements. ringRead nil is a ring miss (fall through to cold); an
// empty non-nil slice means caught up. coldRead returns nil on a lookup failure or a range
// past the row cap (best-effort miss). keep admits a frame by wire type and, per-user, by payload.
func liveVoiceEventsSinceCore(ringRead, coldRead func() [][]byte, keep func([]byte) bool) [][]byte {
	var raw [][]byte
	if buf := ringRead(); buf != nil {
		raw = buf
	} else {
		raw = coldRead()
	}
	if len(raw) == 0 {
		return nil
	}
	filtered := make([][]byte, 0, len(raw))
	for _, evt := range raw {
		if keep(evt) {
			filtered = append(filtered, evt)
		}
	}
	return filtered
}

// liveVoiceEventsSince returns voice_state/voice_leave events for chID at or after afterSeq,
// bypassing the READ-gated channel filter: voice membership can outlive READ_MESSAGES, so a
// resuming participant's room (e.g. a DM call after the DM closed) may not be READ-visible.
// Ring buffer first (fresh), then the cold tier; nil on a miss in both (best-effort).
func (h *Hub) liveVoiceEventsSince(ctx context.Context, afterSeq uint64, chID int64) [][]byte {
	if chID == 0 {
		return nil
	}
	only := map[int64]bool{chID: true}
	return liveVoiceEventsSinceCore(
		func() [][]byte { return h.ReplayBuffer().EventsSinceFiltered(afterSeq, only) },
		func() [][]byte {
			esp := h.events.eventStore.Load()
			if esp == nil {
				return nil
			}
			es := *esp
			coldCap := h.maxColdReplayLimit()
			// Fetch one row past the cap so truncation is decided by the extra row, not len == cap: a window
			// of exactly coldCap rows must replay in full.
			persisted, err := es.GetEventsSinceForChannels(ctx, int64(afterSeq), []int64{chID}, coldCap+1) //nolint:gosec // afterSeq is a sequence counter bounded well below MaxInt64
			if err != nil {
				return nil
			}
			if len(persisted) > coldCap {
				// Same failure mode as reconnectSelectReplay: a result past the cap would drop the newest
				// rows, possibly a peer's voice_leave, installing a join whose leave was discarded. A full
				// ready is unavailable here (registerNow already ran), so nil is the correct degradation.
				slog.Warn("ws liveVoiceEventsSince: cold-tier supplement exceeds the row cap, skipping truncated window",
					"chID", chID, "after_seq", afterSeq, "cap", coldCap)
				return nil
			}
			raw := make([][]byte, 0, len(persisted))
			for _, p := range persisted {
				raw = append(raw, p.Payload)
			}
			return raw
		},
		func(evt []byte) bool {
			switch extractEventType(evt) {
			case MsgTypeVoiceState, MsgTypeVoiceLeaveBC:
				return true
			}
			return false
		},
	)
}

// liveVoiceEventsSinceForUser returns voice_state/voice_leave events at or after afterSeq
// whose payload names userID, bypassing the READ-gated filter. Used when handleReconnect
// has no still-registered old *Client to learn the voice channel from (readPump's teardown
// has usually run and its voice_leave sits in the ring/cold tier under a channel this need
// not know). Nil on a miss or lookup failure (best-effort).
func (h *Hub) liveVoiceEventsSinceForUser(ctx context.Context, afterSeq uint64, userID int64) [][]byte {
	if userID == 0 {
		return nil
	}
	return liveVoiceEventsSinceCore(
		func() [][]byte { return h.ReplayBuffer().EventsSince(afterSeq) },
		func() [][]byte {
			esp := h.events.eventStore.Load()
			if esp == nil {
				return nil
			}
			es := *esp
			coldCap := h.maxColdReplayLimit()
			// Fetch one row past the cap (see liveVoiceEventsSince). This cannot scope to one channel,
			// so the cap is shared with every event type in the range; a busy server can exhaust it
			// before a voice frame, degrading to nil rather than a truncated window presented as complete.
			persisted, err := es.GetEventsSince(ctx, int64(afterSeq), coldCap+1) //nolint:gosec // afterSeq is a sequence counter bounded well below MaxInt64
			if err != nil {
				return nil
			}
			if len(persisted) > coldCap {
				slog.Warn("ws liveVoiceEventsSinceForUser: cold-tier supplement exceeds the row cap, skipping truncated window",
					"user_id", userID, "after_seq", afterSeq, "cap", coldCap)
				return nil
			}
			raw := make([][]byte, 0, len(persisted))
			for _, p := range persisted {
				raw = append(raw, p.Payload)
			}
			return raw
		},
		func(evt []byte) bool {
			switch extractEventType(evt) {
			case MsgTypeVoiceState, MsgTypeVoiceLeaveBC:
				return eventNamesUser(evt, userID)
			}
			return false
		},
	)
}
