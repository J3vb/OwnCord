package ws

import (
	"context"
	"log/slog"
)

// liveVoiceEventsSinceCore is the ring-first / cold-fallback ladder shared by
// the liveVoiceEventsSince* supplements. ringRead returning nil means a ring miss
// (fall through to cold); an empty non-nil slice means caught up. coldRead
// returns nil on a lookup failure or when the range exceeded the row cap, both
// degrading to the best-effort miss. keep admits a frame by wire type and, for
// the per-user variant, by payload.
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

// liveVoiceEventsSince returns voice_state/voice_leave events for chID at or
// after afterSeq, bypassing the READ-gated channel filter: voice membership can
// outlive READ_MESSAGES, so a resuming participant's room (e.g. a DM call after
// the DM closed) is not always in their READ-visible set. Tries the ring buffer
// (fresh, so it sees anything pushed concurrently), then the cold tier; returns
// nil on a miss in both since this is a best-effort supplement.
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
			// Fetch one row past the cap so truncation is decided by the extra row, not
			// len == cap: a complete window of exactly coldCap rows must replay in full.
			persisted, err := es.GetEventsSinceForChannels(ctx, int64(afterSeq), []int64{chID}, coldCap+1) //nolint:gosec // afterSeq is a sequence counter bounded well below MaxInt64
			if err != nil {
				return nil
			}
			if len(persisted) > coldCap {
				// Same failure mode as reconnectSelectReplay: a result past the cap means the
				// newest rows would have been dropped, for a voice room possibly the peer's
				// voice_leave, installing a join whose leave was discarded. A full ready is not
				// available here (registerNow already ran), so nil is the correct degradation.
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

// liveVoiceEventsSinceForUser returns voice_state/voice_leave events at or after
// afterSeq whose own payload names userID, bypassing the READ-gated channel
// filter. Used when handleReconnect has no still-registered old *Client to learn
// the live voice channel from: readPump's disconnect teardown has almost always
// already run, and its voice_leave sits in the ring/cold tier tagged with a
// channel this function need not know, since it filters on user_id. Returns nil
// on a miss or lookup failure (best-effort, like liveVoiceEventsSince).
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
			// Fetch one row past the cap (see liveVoiceEventsSince). This cannot scope the
			// query to one channel, so the cap is shared with every event type in the range;
			// a busy server can exhaust it before a voice frame, degrading to nil rather than
			// a truncated window presented as complete.
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
