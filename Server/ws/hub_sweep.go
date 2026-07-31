package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// staleClientTimeout is the maximum duration a client can go without sending
// any message before being considered stale and disconnected. The client sends
// a ping every 30s, so 90s (3x) gives plenty of margin.
const staleClientTimeout = 90 * time.Second

// kickClient forcibly removes a client from the hub and closes its send channel,
// which causes writePump to exit and the WebSocket connection to close.
// It is safe to call from any goroutine.
func (h *Hub) kickClient(c *Client) {
	h.mu.Lock()
	if current, ok := h.clients[c.userID]; ok && current == c {
		delete(h.clients, c.userID)
	}
	h.mu.Unlock()
	h.pubsub.UnsubscribeAll(c)
	c.closeSend()
}

// startSweep runs sweep on its own goroutine so the hub dispatch loop never
// blocks on the DB-heavy periodic sweeps (they already lock correctly for
// concurrent execution with the hub). inFlight guarantees a sweep never runs
// concurrently with itself: a tick arriving while the previous run is still
// going is dropped, and the next tick retries.
func (h *Hub) startSweep(inFlight *atomic.Bool, sweep func()) {
	if !inFlight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer inFlight.Store(false)
		sweep()
	}()
}

// sweepStaleClients iterates over all connected clients and kicks any that
// have not sent a message within staleClientTimeout.
func (h *Hub) sweepStaleClients() {
	now := time.Now()
	h.mu.RLock()
	var stale []*Client
	for _, c := range h.clients {
		if now.Sub(c.getLastActivity()) > staleClientTimeout {
			stale = append(stale, c)
		}
	}
	h.mu.RUnlock()

	for _, c := range stale {
		slog.Warn("hub: closing stale connection (no activity)",
			"user_id", c.userID, "last_activity", c.getLastActivity())
		h.kickClient(c)
	}
}

// sweepRevokedSessions iterates all connected clients and kicks any whose
// session has been deleted, expired, or whose user has been banned. This
// provides time-based session enforcement for idle WebSocket connections
// that never trigger the message-count-based check (BUG-109).
func (h *Hub) sweepRevokedSessions() {
	if h.db == nil {
		return
	}
	// Hub run-loop sweeper — no request tie.
	ctx := context.Background()

	h.mu.RLock()
	snapshot := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.tokenHash != "" {
			snapshot = append(snapshot, c)
		}
	}
	h.mu.RUnlock()

	if len(snapshot) == 0 {
		return
	}

	// One batched lookup for every connected client instead of a query per
	// client per sweep.
	hashes := make([]string, len(snapshot))
	for i, c := range snapshot {
		hashes[i] = c.tokenHash
	}
	sessions, err := h.db.GetSessionsWithBanStatusBatch(ctx, hashes)
	if err != nil {
		// A failed batch lookup says nothing about any individual session —
		// kicking everyone on a transient DB error would be a mass disconnect.
		// Skip this sweep; the next tick retries.
		slog.Warn("session sweep: batch session lookup failed", "err", err)
		return
	}

	for _, c := range snapshot {
		result := sessions[c.tokenHash]
		if result == nil || auth.IsSessionExpired(result.ExpiresAt) {
			slog.Info("session sweep: revoked/expired session, disconnecting",
				"user_id", c.userID)
			h.kickClient(c)
			continue
		}
		tempUser := &db.User{Banned: result.Banned, BanExpires: result.BanExpires}
		if auth.IsEffectivelyBanned(tempUser) {
			slog.Info("session sweep: banned user, disconnecting",
				"user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeBanned, "you are banned"))
			h.kickClient(c)
		}
	}
}

// sweepStaleVoiceStates queries all voice_states rows and removes any that
// don't match a connected client's voiceChID. This catches ghost users that
// slip through the primary cleanup paths (registerNow, readPump defer,
// LiveKit webhook).
func (h *Hub) sweepStaleVoiceStates() {
	if h.db == nil {
		return
	}
	// Hub run-loop sweeper — no request tie.
	ctx := context.Background()

	// Revocation must evict a live session, not merely block the next join.
	// Nothing else in ws re-validates voice permissions for a connection that
	// stays open, so a user stripped of CONNECT_VOICE kept their SFU session
	// until they disconnected. Checked once a minute, and only for the handful
	// of clients actually in voice.
	h.mu.RLock()
	inVoice := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		if c.getVoiceChID() != 0 {
			inVoice = append(inVoice, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range inVoice {
		chID := c.getVoiceChID()
		if chID == 0 || h.hasChannelPerm(ctx, c, chID, permissions.ConnectVoice) {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: evicting participant whose CONNECT_VOICE was revoked",
			"user_id", c.userID, "channel_id", chID)
		c.sendMsg(buildErrorMsg(ErrCodeForbidden, "missing CONNECT_VOICE permission"))
		h.handleVoiceLeave(ctx, c)
	}

	allStates, err := h.db.GetAllVoiceStates(ctx)
	if err != nil {
		slog.Warn("sweepStaleVoiceStates: GetAllVoiceStates failed", "err", err)
		return
	}
	if len(allStates) == 0 {
		return
	}

	h.mu.RLock()
	var stale []struct {
		userID    int64
		channelID int64
		joinedAt  string
	}
	for _, vs := range allStates {
		c, ok := h.clients[vs.UserID]
		if !ok || c.getVoiceChID() != vs.ChannelID {
			stale = append(stale, struct {
				userID    int64
				channelID int64
				joinedAt  string
			}{vs.UserID, vs.ChannelID, vs.JoinedAt})
		}
	}
	h.mu.RUnlock()

	for _, s := range stale {
		// Channel-conditional delete: only removes the row if it still points
		// at the channel we snapshotted. If the user rejoined or moved between
		// the snapshot and now, the delete is a no-op and we skip the broadcast.
		deleted, err := h.db.LeaveVoiceChannelIfMatch(ctx, s.userID, s.channelID, s.joinedAt)
		if err != nil {
			slog.Error("sweepStaleVoiceStates: LeaveVoiceChannelIfMatch failed",
				"err", err, "user_id", s.userID, "channel_id", s.channelID)
			continue
		}
		if !deleted {
			continue
		}
		slog.Warn("sweepStaleVoiceStates: removed ghost voice state",
			"user_id", s.userID, "channel_id", s.channelID)
		h.broadcastVoiceEvent(ctx, s.channelID, buildVoiceLeave(s.channelID, s.userID))
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(ctx, s.channelID, s.userID, s.joinedAt)
		}
	}
}

// CleanupVoiceForChannel removes all voice participants from the given channel.
// Called when a channel is deleted.
func (h *Hub) CleanupVoiceForChannel(channelID int64) {
	// Cleanup must complete even if the triggering request goes away.
	ctx := context.Background()
	// Get all users in the channel's voice state from DB.
	states, err := h.db.GetChannelVoiceStates(ctx, channelID)
	if err != nil {
		slog.Error("CleanupVoiceForChannel GetChannelVoiceStates", "err", err, "channel_id", channelID)
		return
	}
	if len(states) == 0 {
		return
	}

	// Clean up DB state and LiveKit for each participant.
	for _, vs := range states {
		if err := h.db.LeaveVoiceChannel(ctx, vs.UserID); err != nil {
			slog.Error("CleanupVoiceForChannel LeaveVoiceChannel", "err", err, "user_id", vs.UserID, "channel_id", channelID)
		}

		// Clear client voice state.
		h.mu.RLock()
		if client, ok := h.clients[vs.UserID]; ok {
			client.clearVoiceChID()
		}
		h.mu.RUnlock()

		// Remove from LiveKit (best-effort).
		if h.livekit != nil {
			_ = h.livekit.RemoveParticipant(ctx, channelID, vs.UserID, vs.JoinedAt)
		}
	}

	// Broadcast voice_leave for each participant. All leaves target the same
	// channel, so resolve the READ audience once and reuse it per message.
	audience := h.channelReadAudience(ctx, channelID)
	for _, vs := range states {
		h.broadcastChannelScopedTo(channelID, buildVoiceLeave(channelID, vs.UserID), audience, "voice event")
	}
}
