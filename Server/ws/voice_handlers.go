package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/owncord/server/permissions"
)

// Voice rate limit settings.
const (
	voiceCameraRateLimit      = 2
	voiceCameraWindow         = time.Second
	voiceScreenshareRateLimit = 2
	voiceScreenshareWindow    = time.Second
)

// qualityBitrate returns the target audio bitrate in bits/s based on a quality preset.
func qualityBitrate(quality string) int {
	switch quality {
	case "low":
		return 32000
	case "high":
		return 128000
	default:
		return 64000
	}
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
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "channel_id must be a positive integer"))
		return
	}

	if !h.requireChannelPerm(c, channelID, permissions.ConnectVoice, "CONNECT_VOICE") {
		return
	}

	currentChID := c.getVoiceChID()

	// If user is already in the same voice channel, no-op.
	if currentChID == channelID {
		c.sendMsg(buildErrorMsg("ALREADY_JOINED", "already in this voice channel"))
		return
	}

	// If user is already in a different voice channel, leave it first.
	if currentChID > 0 {
		h.handleVoiceLeave(c)
	}

	ch, err := h.db.GetChannel(channelID)
	if err != nil || ch == nil {
		c.sendMsg(buildErrorMsg("NOT_FOUND", "channel not found"))
		return
	}

	// Check channel capacity.
	maxUsers := ch.VoiceMaxUsers
	if maxUsers > 0 {
		existing, qErr := h.db.GetChannelVoiceStates(channelID)
		if qErr != nil {
			slog.Error("ws handleVoiceJoin GetChannelVoiceStates", "err", qErr, "channel_id", channelID)
			c.sendMsg(buildErrorMsg("INTERNAL", "failed to check channel capacity"))
			return
		}
		if len(existing) >= maxUsers {
			c.sendMsg(buildErrorMsg("CHANNEL_FULL", "voice channel is full"))
			return
		}
	}

	// Persist to DB.
	if err := h.db.JoinVoiceChannel(c.userID, channelID); err != nil {
		slog.Error("ws handleVoiceJoin JoinVoiceChannel", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to join voice channel"))
		return
	}

	// Set voice channel on the client.
	c.setVoiceChID(channelID)

	// Generate LiveKit token if LiveKit client is available.
	if h.livekit != nil {
		if c.user == nil {
			slog.Error("handleVoiceJoin: nil user on client", "user_id", c.userID)
			c.sendMsg(buildErrorMsg("INTERNAL", "not authenticated"))
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

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Gets old voiceChID from clearVoiceChID().
// 2. If was in voice: remove from DB, broadcast voice_leave.
// 3. Call livekit.RemoveParticipant (ignore errors — participant may already be gone).
func (h *Hub) handleVoiceLeave(c *Client) {
	oldChID := c.clearVoiceChID()
	if oldChID == 0 {
		slog.Debug("handleVoiceLeave no-op (already cleared)", "user_id", c.userID)
		return
	}

	slog.Info("voice leave", "user_id", c.userID, "channel_id", oldChID)

	if leaveErr := h.db.LeaveVoiceChannel(c.userID); leaveErr != nil {
		slog.Error("ws handleVoiceLeave LeaveVoiceChannel", "err", leaveErr, "user_id", c.userID)
	}
	h.BroadcastToAll(buildVoiceLeave(oldChID, c.userID))

	// Remove from LiveKit (best-effort).
	if h.livekit != nil {
		if err := h.livekit.RemoveParticipant(oldChID, c.userID); err != nil {
			slog.Debug("handleVoiceLeave RemoveParticipant (may already be gone)",
				"err", err, "user_id", c.userID, "channel_id", oldChID)
		}
	}
}

// handleVoiceMute processes a voice_mute message.
// 1. Parses muted bool.
// 2. Updates DB.
// 3. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceMute(c *Client, payload json.RawMessage) {
	var p struct {
		Muted bool `json:"muted"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_mute payload"))
		return
	}

	if err := h.db.UpdateVoiceMute(c.userID, p.Muted); err != nil {
		slog.Error("ws handleVoiceMute UpdateVoiceMute", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update mute state"))
		return
	}
	slog.Debug("voice mute changed", "user_id", c.userID, "muted", p.Muted)

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceDeafen processes a voice_deafen message.
// 1. Parses deafened bool.
// 2. Updates DB.
// 3. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceDeafen(c *Client, payload json.RawMessage) {
	var p struct {
		Deafened bool `json:"deafened"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_deafen payload"))
		return
	}

	if err := h.db.UpdateVoiceDeafen(c.userID, p.Deafened); err != nil {
		slog.Error("ws handleVoiceDeafen UpdateVoiceDeafen", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update deafen state"))
		return
	}
	slog.Debug("voice deafen changed", "user_id", c.userID, "deafened", p.Deafened)

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceCamera processes a voice_camera message.
// 1. Rate limits at 2/sec per user.
// 2. Checks USE_VIDEO permission.
// 3. Parses enabled bool.
// 4. Enforces MaxVideo limit via LiveKit.
// 5. Updates DB.
// 6. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceCamera(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_camera:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceCameraRateLimit, voiceCameraWindow) {
		c.sendMsg(buildRateLimitError("too many camera toggles", voiceCameraWindow.Seconds()))
		return
	}

	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.UseVideo, "USE_VIDEO") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_camera payload"))
		return
	}

	// Enforce MaxVideo limit when enabling camera.
	if p.Enabled {
		ch, chErr := h.db.GetChannel(voiceChID)
		if chErr == nil && ch != nil && ch.VoiceMaxVideo > 0 && h.livekit != nil {
			videoCount, countErr := h.livekit.CountVideoTracks(voiceChID)
			if countErr != nil {
				slog.Error("handleVoiceCamera CountVideoTracks", "err", countErr, "channel_id", voiceChID)
			} else if videoCount >= ch.VoiceMaxVideo {
				c.sendMsg(buildErrorMsg("VIDEO_LIMIT",
					fmt.Sprintf("maximum %d video streams reached", ch.VoiceMaxVideo)))
				return
			}
		}
	}

	if err := h.db.UpdateVoiceCamera(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceCamera UpdateVoiceCamera", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update camera state"))
		return
	}
	slog.Debug("voice camera changed", "user_id", c.userID, "enabled", p.Enabled)

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceScreenshare processes a voice_screenshare message.
// 1. Rate limits at 2/sec per user.
// 2. Checks SHARE_SCREEN permission.
// 3. Parses enabled bool.
// 4. Updates DB.
// 5. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceScreenshare(c *Client, payload json.RawMessage) {
	ratKey := fmt.Sprintf("voice_screenshare:%d", c.userID)
	if !h.limiter.Allow(ratKey, voiceScreenshareRateLimit, voiceScreenshareWindow) {
		c.sendMsg(buildRateLimitError("too many screenshare toggles", voiceScreenshareWindow.Seconds()))
		return
	}

	voiceChID := c.getVoiceChID()
	if voiceChID == 0 {
		c.sendMsg(buildErrorMsg("VOICE_ERROR", "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.ShareScreen, "SHARE_SCREEN") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg("BAD_REQUEST", "invalid voice_screenshare payload"))
		return
	}

	if err := h.db.UpdateVoiceScreenshare(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceScreenshare UpdateVoiceScreenshare", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg("INTERNAL", "failed to update screenshare state"))
		return
	}
	slog.Debug("voice screenshare changed", "user_id", c.userID, "enabled", p.Enabled)

	h.broadcastVoiceStateUpdate(c)
}

// broadcastVoiceStateUpdate fetches the current voice state for the client
// and broadcasts it to all members of the voice channel they are in.
func (h *Hub) broadcastVoiceStateUpdate(c *Client) {
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil {
		slog.Error("ws broadcastVoiceStateUpdate GetVoiceState", "err", err, "user_id", c.userID)
		return
	}
	if state == nil {
		return // user not in a voice channel — nothing to broadcast
	}
	h.BroadcastToAll(buildVoiceState(*state))
}
