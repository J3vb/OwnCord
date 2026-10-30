package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

const (
	// maxColdReplay caps persisted events a cold-tier replay may return; a gap
	// that reaches it cannot be replayed correctly and falls back to a full ready.
	maxColdReplay = 5000
)

// handleReconnect attempts to resume a client via replay. handled reports whether
// this function owns the outcome; false means fall through to handleFreshConnect
// for a full ready. startPumps is meaningful only when handled and is false on
// the handshake-write-failure paths: those already ran the full
// unregisterFailedHandshake teardown and closed conn, and a pump would run it a
// second time (duplicate StampDisconnect, offline presence broadcast, hub seq).
func (h *Hub) handleReconnect(
	ctx context.Context, conn *websocket.Conn, c *Client, lastSeq uint64,
) (handled, startPumps bool) {
	allowedChannelIDs, nsfwReadableChannelIDs, ok := h.reconnectPrecheck(ctx, c, lastSeq)
	if !ok {
		return false, false
	}

	// Voice membership can outlive READ_MESSAGES (checked only at join), so a live
	// participant resuming can have their room excluded from allowedChannelIDs (e.g.
	// a DM call after the DM was closed). Capture it before registerNow does the same
	// lookup/transfer so replay can be supplemented with the room's voice_state and
	// voice_leave. It is never added to allowedChannelIDs: that map also gates the
	// ChannelTopic subscription in registerNow and would leak the channel's chat.
	//
	// old is nil on almost every ordinary reconnect, hence the liveVoiceChID == 0
	// fallback below (see liveVoiceEventsSinceForUser).
	var liveVoiceChID int64
	old := h.sessionClient(c.userID, c.tokenHash)
	if old != nil {
		liveVoiceChID = old.voice.channel()
	}

	events, replaySource, persistedTail, maxPersistedSeq := h.reconnectSelectReplay(ctx, c, lastSeq, allowedChannelIDs, nsfwReadableChannelIDs)
	if events == nil {
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return false, false
	}

	// Register before writing replay data so broadcasts arriving during the write
	// window queue in the client's send buffer (writePump has not started; they drain
	// once the pumps begin).
	//
	// The replay set can go stale before c is reachable: deliverBroadcast allocates a
	// seq, pushes to the ring buffer and publishes to subscribers under h.seqMu,
	// concurrently with this goroutine. A broadcast landing between the snapshot and
	// registration reaches nobody, and the client tracks only max(seq) so it can
	// never ask for it again. Close the window by re-reading the ring-buffer portion
	// and calling registerNow inside the same h.seqMu section (reconnectRegister).
	// Restore the client's channel subscription before registration. registerNow
	// copies it from the old client entry, but when the server already saw the old
	// socket close there is none to copy, leaving the resumed connection without a
	// ChannelTopic subscription until its channel_focus round trip completes.
	// Everything broadcast in that window would reach nobody on this socket and the
	// client can never ask for it back.
	//
	// Set outside the h.seqMu section below since it needs no seq ordering
	// (seqMu -> c.mu is a normal edge: lock_order.go).
	//
	// c.authChannelID is attacker-controlled, so it is honoured only when the freshly
	// computed read-permission set contains it. Fail closed: otherwise channelID stays 0.
	if c.authChannelID != 0 {
		if allowedChannelIDs[c.authChannelID] {
			c.mu.Lock()
			c.channelID = c.authChannelID
			c.mu.Unlock()
		} else {
			slog.Debug("ws handleReconnect: ignoring unreadable active_channel_id from auth frame",
				"user_id", c.userID, "channel_id", c.authChannelID)
		}
	}

	events, ok = h.reconnectRegister(ctx, c, lastSeq, allowedChannelIDs, nsfwReadableChannelIDs, replaySource, persistedTail, maxPersistedSeq)
	if !ok {
		return false, false
	}

	// reconnectRegister just made c reachable via h.clients, the earliest point a
	// revocation racing reconnectPrecheck's DB work could find this socket. Kept
	// outside reconnectRegister's h.seqMu section: a DB round trip must not extend
	// the critical section that serializes every broadcast.
	if v := h.postRegisterSessionRecheck(ctx, c); v != postRegisterOK {
		// The teardown already ran inside postRegisterSessionRecheck, so only conn needs
		// closing; startPumps=false so readPump never starts on it.
		closeAbortedHandshake(ctx, conn, v)
		return true, false
	}

	// nsfwReadableChannelIDs was snapshotted in reconnectPrecheck, several DB round
	// trips and a seqMu section ago. An acknowledge, revoke or re-label landing
	// between two frames of this replay would leak everything after it, so
	// reconnectWriteReplay re-checks each content-bearing frame live just before
	// writing it (frameReadableNow).
	switch replaySource {
	case "buffer":
		h.reconnectTierBuf.Add(1)
	case "db":
		h.reconnectTierDB.Add(1)
	}
	telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", replaySource))

	// Best-effort supplement: the user's live voice room may sit outside
	// allowedChannelIDs (see liveVoiceChID above), so its voice_state/voice_leave
	// would otherwise never reach this replay. Tries the ring buffer, then the cold
	// tier; a miss on both is a no-op.
	switch {
	case liveVoiceChID != 0 && !allowedChannelIDs[liveVoiceChID]:
		events = append(events, h.liveVoiceEventsSince(ctx, lastSeq, liveVoiceChID)...)
	case old == nil:
		// No still-registered old *Client to source the room from, so scan by the
		// resuming user's own id. Frames whose channel is in allowedChannelIDs are
		// skipped: the main replay carries them and re-adding would duplicate them.
		for _, evt := range h.liveVoiceEventsSinceForUser(ctx, lastSeq, c.userID) {
			if !allowedChannelIDs[payloadChannelID(evt)] {
				events = append(events, evt)
			}
		}
	}

	// Settle the session's status before the auth_ok write, as handleFreshConnect
	// does: reconnectWriteReplay reads c.user.Status to build auth_ok, and after
	// StampDisconnect that would be the disconnect-time status (routinely "offline")
	// rather than the one the user is coming online as. Skips member_join.
	h.applyConnectStatus(ctx, c)

	if !h.reconnectWriteReplay(ctx, conn, c, lastSeq, events, replaySource) {
		// The teardown inside reconnectWriteReplay already ran in full; a readPump on
		// this closed conn would hit a Read error and run it a second time.
		return true, false
	}

	h.announceConnectPresence(c)

	return true, true
}

// reconnectPrecheck runs handleReconnect's two entry guards and, when replay is
// still possible, returns the read-permission set replay is filtered by
// (allowedChannelIDs) and its NSFW narrowing (nsfwReadableChannelIDs: visibility
// minus unacknowledged labelled channels). ok=false means fall through to a full ready.
func (h *Hub) reconnectPrecheck(
	ctx context.Context, c *Client, lastSeq uint64,
) (allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool, ok bool) {
	// Use the configured seam, never a caller-supplied handle, so a service-backed or
	// instrumented reader intercepts the reads below (as handleFreshConnect does).
	database := h.readers.Visibility
	// Replay cannot repair a missed visibility change (targeted, unsequenced), a shed
	// content frame (never got a seq) or a dropped presence frame: full ready.
	if h.mustFullResync(lastSeq) || h.presenceResyncPending(c.userID, c.tokenHash) {
		slog.Info("ws replay skipped (resync watermark at or past last_seq, or presence dropped), sending full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, nil, false
	}
	// c.user is the auth-time snapshot; a role change between authenticateConn and
	// here would otherwise be resolved from the old RoleID for the socket's life
	// (revokeUnreadableChannels early-returns for a socket not yet in h.clients and
	// nothing revalidates handshake-time subscriptions). Re-read the row so the
	// permission set uses the current role.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Warn("ws handleReconnect: user re-read failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
	// Channel-scoped replay events are filtered by the user's current permissions.
	allowedChannelIDs, err := h.computeAllowedChannels(ctx, database, c.user)
	if err != nil {
		slog.Warn("ws handleReconnect: computeAllowedChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
	nsfwReadableChannelIDs, err = h.computeReadableChannels(ctx, database, c.user, allowedChannelIDs)
	if err != nil {
		slog.Warn("ws handleReconnect: computeReadableChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
	// A socket without the forums feature replays nothing sequenced on a forum.
	if err := h.dropForumChannels(ctx, database, c, allowedChannelIDs, nsfwReadableChannelIDs); err != nil {
		slog.Warn("ws handleReconnect: dropForumChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
	return allowedChannelIDs, nsfwReadableChannelIDs, true
}

// reconnectSelectReplay picks the tier that serves this resume (the ring buffer if
// it covers lastSeq, else the cold-tier EventStore) and returns the events, the
// tier name and, cold tier only, the persisted rows plus their highest seq for
// reconnectRegister's re-read. Nil events means neither tier can replay.
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
	// Try cold-tier replay from the EventStore before forcing a full ready.
	if esp := h.eventStore.Load(); esp != nil {
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
			// The query is ORDER BY seq ASC LIMIT maxColdReplay, so a full result means the
			// gap exceeds the cap and the newest events were dropped. Replaying it would look
			// like a complete resume (the client tracks only max(seq)) and silently lose
			// state events REST history never repairs. Leave events nil to force a full ready.
			slog.Warn("ws handleReconnect: cold-tier replay hit the row cap, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq, "cap", coldCap)
		case len(persisted) > 0:
			// Retention pruning deletes purely by created_at with no seq-floor coordination,
			// so this channel-filtered result can be a surviving suffix after the events
			// between lastSeq and persisted[0] were pruned, which would present a hole as a
			// complete resume. Probe the store's oldest surviving seq unfiltered: a
			// contiguity check on persisted itself cannot work since a sparse per-channel
			// result is legitimately non-contiguous.
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

// reconnectVetColdTail turns a cold-tier result into a replayable tail, or nil
// when it cannot be trusted: the range must have no interior gap and the ring
// buffer must cover everything newer than its last row. The returned seq is the
// highest in persisted.
func (h *Hub) reconnectVetColdTail(
	ctx context.Context, c *Client, es EventStore, lastSeq uint64,
	persisted []db.PersistedEvent, allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool,
) ([][]byte, uint64) {
	// A content-bearing row for an allowed but unreadable (labelled, unacknowledged)
	// channel is dropped, the same rule EventsSinceFilteredContent applies to the
	// ring buffer. Checked against the row's stored EventType/ChannelID, not its payload.
	persistedTail := make([][]byte, 0, len(persisted))
	for _, p := range persisted {
		if contentBearingKinds[p.EventType] && !nsfwReadableChannelIDs[p.ChannelID] {
			continue
		}
		persistedTail = append(persistedTail, p.Payload)
	}
	maxPersistedSeq := uint64(persisted[len(persisted)-1].Seq) //nolint:gosec // seq is a counter bounded well below MaxInt64

	// persisted is channel-filtered, so a hole in a channel outside
	// allowedChannelIDs would slip past a contiguity check on it, and EventPersister
	// can lose a row outright (full queue drops silently in Enqueue; a per-row insert
	// failure in a batch flush is only logged). Count the unfiltered range
	// (lastSeq, maxPersistedSeq] and require every seq present; seq is the primary
	// key so the count can only come up short.
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
		// EventPersister flushes asynchronously, so cold rows can lag the live seq and
		// newer events sit only in the ring buffer. Confirm the buffer covers everything
		// above the newest persisted row; a hole must force a full ready, not a replay
		// with a silent gap at its end. (The authoritative re-read is atomic with
		// registerNow.)
		switch tail := h.ReplayBuffer().EventsSinceFilteredContent(maxPersistedSeq, allowedChannelIDs, nsfwReadableChannelIDs); {
		case tail != nil:
		case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
			// Post-restart empty buffer with the hub seq seeded from the store max: nothing
			// was broadcast after the last persisted row.
		default:
			slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail, forcing full ready",
				"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
			persistedTail = nil
		}
	}
	return persistedTail, maxPersistedSeq
}

// reconnectRegister re-reads the ring-buffer portion of the replay and registers c
// inside the same h.seqMu section deliverBroadcast uses, so no seq can be
// allocated in between. ok=false means a re-check tripped and the caller must
// fall through to a full ready.
func (h *Hub) reconnectRegister(
	ctx context.Context, c *Client, lastSeq uint64, allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool,
	replaySource string, persistedTail [][]byte, maxPersistedSeq uint64,
) (events [][]byte, ok bool) {
	// Drop a parked grace entry whose row is gone (a DB read, so before h.seqMu).
	txn := h.begin(c.userID)
	defer txn.end()
	h.dropOrphanVoiceGrace(ctx, c.userID)
	if handleReconnectPreSeqMuRaceHook != nil {
		handleReconnectPreSeqMuRaceHook()
	}
	h.seqMu.Lock()
	start := time.Now()
	switch replaySource {
	case "buffer":
		fresh := h.ReplayBuffer().EventsSinceFilteredContent(lastSeq, allowedChannelIDs, nsfwReadableChannelIDs)
		if fresh == nil {
			// The buffer window closed since the earlier check (an extreme write burst
			// evicted lastSeq); only a full ready is left.
			h.observeSeqMuHold(start)
			h.seqMu.Unlock()
			slog.Warn("ws handleReconnect: buffer window closed just before registration, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq)
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return nil, false
		}
		events = fresh
	case "db":
		switch tail := h.ReplayBuffer().EventsSinceFilteredContent(maxPersistedSeq, allowedChannelIDs, nsfwReadableChannelIDs); {
		case tail != nil:
			events = append(append([][]byte{}, persistedTail...), tail...)
		case atomic.LoadUint64(&h.seq) == maxPersistedSeq:
			events = persistedTail
		default:
			h.observeSeqMuHold(start)
			h.seqMu.Unlock()
			slog.Warn("ws handleReconnect: ring buffer cannot cover the post-flush tail just before registration, forcing full ready",
				"user_id", c.userID, "max_persisted_seq", maxPersistedSeq)
			h.reconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return nil, false
		}
	}
	if handleReconnectPreRegisterRaceHook != nil {
		handleReconnectPreRegisterRaceHook()
	}
	// Re-check the watermark right before registerNow makes this connection
	// reachable. RefreshChannelVisibility and revokeUnreadableChannels fan out a
	// targeted, unsequenced channel_create/channel_delete over h.clients, a snapshot
	// this mid-handshake connection is absent from. A change landing after the entry
	// check would otherwise be missed twice. A fan-out still in flight is caught by
	// the targetedFanouts counter, a finished one by the watermark it bumped.
	if h.mustFullResyncAtRegister(lastSeq, c.userID, c.tokenHash) {
		h.observeSeqMuHold(start)
		h.seqMu.Unlock()
		slog.Warn("ws handleReconnect: resync watermark moved during handshake, forcing full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.reconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, false
	}
	if handleReconnectPostCheckPreRegisterRaceHook != nil {
		handleReconnectPostCheckPreRegisterRaceHook()
	}
	h.registerNow(c, allowedChannelIDs, txn)
	h.observeSeqMuHold(start)
	h.seqMu.Unlock()
	return events, true
}

// reconnectWriteReplay writes the resume handshake: auth_ok then the replayed
// events. False means a write failed, the full unregisterFailedHandshake teardown
// already ran and conn is closed, so the caller must not start any pump.
func (h *Hub) reconnectWriteReplay(
	ctx context.Context, conn *websocket.Conn, c *Client, lastSeq uint64,
	events [][]byte, replaySource string,
) bool {
	// The replay tier is in the payload so the client can attribute reconnect behaviour without metric scraping.
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName, "replay_source", replaySource)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, c.roleIDs, replaySource)); err != nil {
		slog.Warn("ws: failed to send auth_ok (reconnect)", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return false
	}
	written := 0
	for _, evt := range events {
		// Re-check a content-bearing frame's readability live, immediately before it
		// goes out, not from a batch snapshot (see handleReconnect). A revoke/unlabel
		// landing between two frames of the same reconnect is honoured from the very next
		// frame it affects.
		if contentBearingKinds[extractEventType(evt)] {
			chID := payloadChannelID(evt)
			if reconnectFrameReadableRaceHook != nil {
				reconnectFrameReadableRaceHook(c.userID, chID)
			}
			if !h.replayFrameAllowed(ctx, c, chID) {
				continue
			}
		}
		if err := handshakeWrite(ctx, conn, c.stampCseq(evt)); err != nil {
			slog.Warn("ws: failed to send replay event", "user_id", c.userID, "err", err)
			h.unregisterFailedHandshake(ctx, c)
			_ = conn.Close(websocket.StatusInternalError, "handshake failed")
			return false
		}
		written++
	}
	slog.Info("ws replay completed", "user_id", c.userID, "events_replayed", written, "from_seq", lastSeq, "source", replaySource)
	return true
}

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
			esp := h.eventStore.Load()
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
			esp := h.eventStore.Load()
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
