package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/permissions"
)

// validVoiceQuality returns true if q is an accepted voice quality preset.
// Uses voiceQualities (defined in voice_broadcast.go) as the single source of truth.
func validVoiceQuality(q string) bool {
	_, ok := voiceQualities[q]
	return ok
}

// handleVoiceJoin processes a voice_join message.
// 1. Parses channel_id.
// 2. Checks CONNECT_VOICE permission.
// 3. If already in a different voice channel, leaves it first.
// 4. Checks channel capacity (voice_max_users).
// 5. Persists join in DB.
// 6. Generates LiveKit token and sends voice_token to the client.
// 7. Sends existing voice states to the joiner.
// 8. Broadcasts voice_state to all clients.
// 9. Sends voice_config to the joiner.
func (h *Hub) handleVoiceJoin(c *Client, payload json.RawMessage) {
	channelID, err := parseChannelID(payload)
	if err != nil || channelID <= 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "channel_id must be a positive integer"))
		return
	}

	if !h.requireChannelPerm(c, channelID, permissions.ConnectVoice, "CONNECT_VOICE") {
		return
	}

	// Guard: reject voice join if LiveKit is configured but the companion
	// process is not running (e.g. crashed 10 times and gave up).
	// When livekit is nil, voice still works — just without SFU tokens.
	if h.livekit != nil && h.lkProcess != nil && !h.lkProcess.IsRunning() {
		slog.Warn("handleVoiceJoin: LiveKit process not running", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "voice is temporarily unavailable — LiveKit is not running"))
		return
	}

	currentChID := c.getVoiceChID()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg(ErrCodeAlreadyJoined, "already in this voice channel"))
		return
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(c)
	}

	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg(ErrCodeNotFound, "channel not found"))
		return
	}

	// Check channel capacity.
	maxUsers := ch.VoiceMaxUsers
	if maxUsers > 0 {
		existing, qErr := h.db.GetChannelVoiceStates(channelID)
		if qErr != nil {
			slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", qErr, "channel_id", channelID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to check channel capacity"))
			return
		}
		if len(existing) >= maxUsers {
			c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
			return
		}
	}

	// Persist to DB.
	if err := h.db.JoinVoiceChannel(c.userID, channelID); err != nil {
		slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return
	}

	// Set voice channel on the client.
	c.setVoiceChID(channelID)

	// Generate LiveKit token if LiveKit client is available.
	// Token generation failure is fatal — without a token the client cannot
	// connect to the SFU, so we must roll back the DB join.
	if h.livekit != nil {
		if c.user == nil {
			slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
			h.rollbackVoiceJoin(c, channelID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
			return
		}
		// Derive publish permissions from role — prevents SFU-level bypass
		// when client connects directly via direct_url.
		canPublish := h.hasChannelPerm(c, channelID, permissions.SpeakVoice)
		canSubscribe := true
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, canPublish, canSubscribe)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			h.rollbackVoiceJoin(c, channelID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to generate voice token"))
			return
		}
		// Send both proxy path and direct URL. The client uses direct_url
		// when on localhost (avoids self-signed TLS issues with WebView
		// fetch) and falls back to the /livekit proxy for remote clients.
		c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL()))
	}

	// Get and broadcast the joiner's state. Failure here means other users
	// won't see the join (ghost state), so roll back to avoid inconsistency.
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
		h.rollbackVoiceJoin(c, channelID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to join voice channel"))
		return
	}

	// Broadcast the joiner's state to all connected clients.
	h.BroadcastToAll(buildVoiceState(*state))

	// Send existing channel voice states to the joiner.
	existing, err := h.db.GetChannelVoiceStates(channelID)
	if err != nil {
		slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", err)
		return
	}
	for _, vs := range existing {
		if vs.UserID == c.userID {
			continue
		}
		c.sendMsg(buildVoiceState(vs))
	}

	// Send voice_config to the joiner.
	quality := "medium"
	if ch.VoiceQuality != nil && *ch.VoiceQuality != "" {
		q := *ch.VoiceQuality
		if validVoiceQuality(q) {
			quality = q
		} else {
			slog.Warn("ws handleVoiceJoin invalid voice quality, using default",
				"quality", q, "channel_id", channelID)
		}
	}
	bitrate := qualityBitrate(quality)
	c.sendMsg(buildVoiceConfig(channelID, quality, bitrate, maxUsers))

	slog.Info("voice join", "user_id", c.userID, "channel_id", channelID)
}

// handleVoiceTokenRefresh generates a fresh LiveKit token for a client
// that is already in a voice channel. This lets clients request a new token
// (e.g. before a manual reconnect) without leaving and rejoining voice.
func (h *Hub) handleVoiceTokenRefresh(c *Client) {
	ratKey := fmt.Sprintf("voice_token_refresh:%d", c.userID)
	if !h.limiter.Allow(ratKey, 1, 60*time.Second) {
		c.sendMsg(buildRateLimitError("token refresh rate limited", 60))
		return
	}

	channelID := c.getVoiceChID()
	if channelID == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "not in voice"))
		return
	}

	if h.livekit == nil {
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice not configured"))
		return
	}

	if c.user == nil {
		slog.Error("handleVoiceTokenRefresh: nil user on client", "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
		return
	}

	canPublish := h.hasChannelPerm(c, channelID, permissions.SpeakVoice)
	canSubscribe := true
	token, err := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, canPublish, canSubscribe)
	if err != nil {
		slog.Error("ws handleVoiceTokenRefresh GenerateToken", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to generate voice token"))
		return
	}

	c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL()))
	slog.Info("voice token refreshed", "user_id", c.userID, "channel_id", channelID)
}

// rollbackVoiceJoin undoes a partially-completed voice join: clears the
// client's voice channel ID, removes the DB voice state row, and broadcasts
// voice_leave so other clients don't see a ghost participant.
func (h *Hub) rollbackVoiceJoin(c *Client, channelID int64) {
	c.clearVoiceChID()
	if err := h.db.LeaveVoiceChannel(c.userID); err != nil {
		slog.Error("ws rollbackVoiceJoin LeaveVoiceChannel", "err", err,
			"user_id", c.userID, "channel_id", channelID)
	}
	h.BroadcastToAll(buildVoiceLeave(channelID, c.userID))
}
