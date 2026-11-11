package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/J3vb/OwnCord/Server/telemetry"
)

const (
	// maxColdReplay caps events a cold-tier replay may return; a gap reaching it falls back to a full ready.
	maxColdReplay = 5000
)

// handleReconnect attempts to resume a client via replay. handled false means fall through
// to handleFreshConnect. startPumps is false on handshake-write-failure paths, which already
// ran the full unregisterFailedHandshake teardown; a pump would repeat it (duplicate
// StampDisconnect, offline broadcast, hub seq).
func (h *Hub) handleReconnect(
	ctx context.Context, conn *websocket.Conn, c *Client, lastSeq uint64,
) (handled, startPumps bool) {
	allowedChannelIDs, nsfwReadableChannelIDs, ok := h.reconnectPrecheck(ctx, c, lastSeq)
	if !ok {
		return false, false
	}

	// Voice membership can outlive READ_MESSAGES (checked only at join), so a live participant's
	// room (e.g. a closed DM call) may be missing from allowedChannelIDs. Capture it before
	// registerNow so replay can add the room's voice_state/voice_leave. Never add it to
	// allowedChannelIDs: that also gates the ChannelTopic subscription and would leak chat. old
	// is nil on most reconnects, hence the liveVoiceChID == 0 fallback below.
	var liveVoiceChID int64
	old := h.sessionClient(c.userID, c.tokenHash)
	if old != nil {
		liveVoiceChID = old.voice.channel()
	}

	events, replaySource, persistedTail, maxPersistedSeq := h.reconnectSelectReplay(ctx, c, lastSeq, allowedChannelIDs, nsfwReadableChannelIDs)
	if events == nil {
		h.stats.ReconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return false, false
	}

	// Register before writing replay so broadcasts arriving during the write queue in the send
	// buffer. The replay set can go stale before c is reachable (deliverBroadcast allocates a
	// seq under h.seqMu), and the client tracks only max(seq), so a broadcast in the gap is lost
	// forever: re-read the ring-buffer portion and registerNow in one h.seqMu section
	// (reconnectRegister). Restore the channel subscription outside that section (no seq
	// ordering needed; seqMu -> c.mu is a normal edge: lock_order.go), since registerNow copies it
	// from an old entry that may already be gone. c.authChannelID is attacker-controlled, so
	// honour it only when the fresh read-permission set contains it; fail closed (channelID 0).
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

	// c is now reachable via h.clients, the earliest a racing revocation could find it. Kept
	// outside reconnectRegister's seqMu section: a DB round trip must not extend the critical
	// section that serializes every broadcast.
	if v := h.postRegisterSessionRecheck(ctx, c); v != postRegisterOK {
		// Teardown already ran in postRegisterSessionRecheck; only close conn, startPumps=false.
		closeAbortedHandshake(ctx, conn, v)
		return true, false
	}

	// nsfwReadableChannelIDs is a stale snapshot; an acknowledge, revoke or re-label between
	// frames would leak, so reconnectWriteReplay re-checks each content frame live
	// (frameReadableNow).
	switch replaySource {
	case "buffer":
		h.stats.ReconnectTierBuf.Add(1)
	case "db":
		h.stats.ReconnectTierDB.Add(1)
	}
	telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", replaySource))

	// Best-effort: the user's live voice room may sit outside allowedChannelIDs, so add its
	// voice_state/voice_leave from the ring buffer, then the cold tier; a miss is a no-op.
	switch {
	case liveVoiceChID != 0 && !allowedChannelIDs[liveVoiceChID]:
		events = append(events, h.liveVoiceEventsSince(ctx, lastSeq, liveVoiceChID)...)
	case old == nil:
		// No old *Client to source the room from, so scan by user id. Frames in allowedChannelIDs
		// are skipped: the main replay carries them.
		for _, evt := range h.liveVoiceEventsSinceForUser(ctx, lastSeq, c.userID) {
			if !allowedChannelIDs[payloadChannelID(evt)] {
				events = append(events, evt)
			}
		}
	}

	// Settle the status before auth_ok, as handleFreshConnect does: reconnectWriteReplay reads
	// c.user.Status, which after StampDisconnect would be "offline". Skips member_join.
	h.applyConnectStatus(ctx, c)

	if !h.reconnectWriteReplay(ctx, conn, c, lastSeq, events, replaySource) {
		// Teardown already ran in reconnectWriteReplay; a readPump on this conn would run it twice.
		return true, false
	}

	h.announceConnectPresence(c)

	return true, true
}

// reconnectPrecheck runs handleReconnect's entry guards and, when replay is possible,
// returns the read-permission set (allowedChannelIDs) and its NSFW narrowing
// (nsfwReadableChannelIDs). ok=false means fall through to a full ready.
func (h *Hub) reconnectPrecheck(
	ctx context.Context, c *Client, lastSeq uint64,
) (allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool, ok bool) {
	// Use the configured seam, never a caller-supplied handle, so an instrumented reader intercepts the
	// reads.
	database := h.readers.Visibility
	// Replay cannot repair a missed visibility change, a shed content frame or a dropped presence frame: full
	// ready.
	if h.mustFullResync(lastSeq) || h.presenceResyncPending(c.userID, c.tokenHash) {
		slog.Info("ws replay skipped (resync watermark at or past last_seq, or presence dropped), sending full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.stats.ReconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, nil, false
	}
	// c.user is the auth-time snapshot; a role change since would be resolved from the old
	// RoleID for the socket's life (nothing revalidates handshake-time subscriptions). Re-read
	// so the permission set uses the current role.
	if err := h.refreshUserSnapshot(ctx, database, c); err != nil {
		slog.Warn("ws handleReconnect: user re-read failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
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
	if err := h.dropForumChannels(ctx, database, c, allowedChannelIDs, nsfwReadableChannelIDs); err != nil {
		slog.Warn("ws handleReconnect: dropForumChannels failed, falling back to full ready",
			"user_id", c.userID, "err", err)
		return nil, nil, false
	}
	return allowedChannelIDs, nsfwReadableChannelIDs, true
}

// reconnectRegister re-reads the ring-buffer portion of the replay and registers c inside
// the same h.seqMu section deliverBroadcast uses, so no seq is allocated in between.
// ok=false means a re-check tripped: fall through to a full ready.
func (h *Hub) reconnectRegister(
	ctx context.Context, c *Client, lastSeq uint64, allowedChannelIDs, nsfwReadableChannelIDs map[int64]bool,
	replaySource string, persistedTail [][]byte, maxPersistedSeq uint64,
) (events [][]byte, ok bool) {
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
			// The buffer window closed (a write burst evicted lastSeq); only a full ready is left.
			h.observeSeqMuHold(start)
			h.seqMu.Unlock()
			slog.Warn("ws handleReconnect: buffer window closed just before registration, forcing full ready",
				"user_id", c.userID, "last_seq", lastSeq)
			h.stats.ReconnectTierFull.Add(1)
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
			h.stats.ReconnectTierFull.Add(1)
			telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
			return nil, false
		}
	}
	if handleReconnectPreRegisterRaceHook != nil {
		handleReconnectPreRegisterRaceHook()
	}
	// Re-check the watermark right before registerNow. Targeted, unsequenced fan-outs
	// (RefreshChannelVisibility, revokeUnreadableChannels) skip this mid-handshake connection;
	// an in-flight one is caught by targetedFanouts, a finished one by the watermark.
	if h.mustFullResyncAtRegister(lastSeq, c.userID, c.tokenHash) {
		h.observeSeqMuHold(start)
		h.seqMu.Unlock()
		slog.Warn("ws handleReconnect: resync watermark moved during handshake, forcing full ready",
			"user_id", c.userID, "last_seq", lastSeq)
		h.stats.ReconnectTierFull.Add(1)
		telemetry.NewAppMetrics().WSReconnectTierTotal.Add(ctx, 1, telemetry.String("tier", "full"))
		return nil, false
	}
	if handleReconnectPostCheckPreRegisterRaceHook != nil {
		handleReconnectPostCheckPreRegisterRaceHook()
	}
	c.resumeReadable = allowedChannelIDs
	h.registerNow(c, allowedChannelIDs, txn)
	h.observeSeqMuHold(start)
	h.seqMu.Unlock()
	return events, true
}

// reconnectWriteReplay writes auth_ok then the replayed events. False means a write failed,
// teardown already ran and conn is closed: start no pump.
func (h *Hub) reconnectWriteReplay(
	ctx context.Context, conn *websocket.Conn, c *Client, lastSeq uint64,
	events [][]byte, replaySource string,
) bool {
	slog.Info("ws sending auth_ok (reconnect)", "user_id", c.userID, "username", c.user.Username, "role", c.roleName, "replay_source", replaySource)
	if err := handshakeWrite(ctx, conn, h.buildAuthOK(ctx, c.user, c.roleName, c.roleIDs, replaySource)); err != nil {
		slog.Warn("ws: failed to send auth_ok (reconnect)", "user_id", c.userID, "err", err)
		h.unregisterFailedHandshake(ctx, c)
		_ = conn.Close(websocket.StatusInternalError, "handshake failed")
		return false
	}
	written := 0
	for _, evt := range events {
		// Re-check readability live just before each content frame, not from a batch snapshot: a
		// revoke/unlabel between frames is honoured from the next frame.
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
