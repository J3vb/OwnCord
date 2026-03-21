package ws

import (
	"encoding/json"
	"log/slog"

	"github.com/owncord/server/permissions"
)

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
	if h.livekit != nil {
		if c.user == nil {
			slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "not authenticated"))
			return
		}
		canPublish := true
		canSubscribe := true
		token, tokenErr := h.livekit.GenerateToken(c.userID, c.user.Username, channelID, canPublish, canSubscribe)
		if tokenErr != nil {
			slog.Error("ws handleVoiceJoin GenerateToken", "err", tokenErr, "user_id", c.userID)
			// Non-fatal: voice join still succeeds at the DB/state level.
		} else {
			// Send both proxy path and direct URL. The client uses direct_url
			// when on localhost (avoids self-signed TLS issues with WebView
			// fetch) and falls back to the /livekit proxy for remote clients.
			c.sendMsg(buildVoiceToken(channelID, token, "/livekit", h.livekit.URL()))
		}
	}

	// Get and broadcast the joiner's state.
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil || state == nil {
		slog.Error("ws handleVoiceJoin GetVoiceState", "err", err, "user_id", c.userID)
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
		quality = *ch.VoiceQuality
	}
	bitrate := qualityBitrate(quality)
	c.sendMsg(buildVoiceConfig(channelID, quality, bitrate, maxUsers))

	slog.Info("voice join", "user_id", c.userID, "channel_id", channelID)
}
