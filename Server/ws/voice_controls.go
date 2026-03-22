package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/permissions"
)

// handleVoiceMute processes a voice_mute message.
// 1. Parses muted bool.
// 2. Updates DB.
// 3. Broadcasts voice_state update to channel.
func (h *Hub) handleVoiceMute(c *Client, payload json.RawMessage) {
	if c.getVoiceChID() == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "not in a voice channel"))
		return
	}

	var p struct {
		Muted bool `json:"muted"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid voice_mute payload"))
		return
	}

	if err := h.db.UpdateVoiceMute(c.userID, p.Muted); err != nil {
		slog.Error("ws handleVoiceMute UpdateVoiceMute", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to update mute state"))
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
	if c.getVoiceChID() == 0 {
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "not in a voice channel"))
		return
	}

	var p struct {
		Deafened bool `json:"deafened"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid voice_deafen payload"))
		return
	}

	if err := h.db.UpdateVoiceDeafen(c.userID, p.Deafened); err != nil {
		slog.Error("ws handleVoiceDeafen UpdateVoiceDeafen", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to update deafen state"))
		return
	}
	slog.Debug("voice deafen changed", "user_id", c.userID, "deafened", p.Deafened)

	h.broadcastVoiceStateUpdate(c)
}

// handleVoiceCamera processes a voice_camera message.
// 1. Rate limits at 2/sec per user.
// 2. Checks USE_VIDEO permission.
// 3. Parses enabled bool.
// 4. Enforces MaxVideo limit via DB count (race-free).
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
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.UseVideo, "USE_VIDEO") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid voice_camera payload"))
		return
	}

	// Enforce MaxVideo limit when enabling camera.
	// Count from DB (race-free via SQLite serialization) instead of LiveKit API.
	if p.Enabled {
		ch, chErr := h.db.GetChannel(voiceChID)
		if chErr == nil && ch != nil && ch.VoiceMaxVideo > 0 {
			videoCount, countErr := h.db.CountActiveCameras(voiceChID)
			if countErr != nil {
				slog.Error("handleVoiceCamera CountActiveCameras", "err", countErr, "channel_id", voiceChID)
				c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to check video limit"))
				return
			} else if videoCount >= ch.VoiceMaxVideo {
				c.sendMsg(buildErrorMsg(ErrCodeVideoLimit,
					fmt.Sprintf("maximum %d video streams reached", ch.VoiceMaxVideo)))
				return
			}
		}
	}

	if err := h.db.UpdateVoiceCamera(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceCamera UpdateVoiceCamera", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to update camera state"))
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
		c.sendMsg(buildErrorMsg(ErrCodeVoiceError, "not in a voice channel"))
		return
	}

	if !h.requireChannelPerm(c, voiceChID, permissions.ShareScreen, "SHARE_SCREEN") {
		return
	}

	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeBadRequest, "invalid voice_screenshare payload"))
		return
	}

	if err := h.db.UpdateVoiceScreenshare(c.userID, p.Enabled); err != nil {
		slog.Error("ws handleVoiceScreenshare UpdateVoiceScreenshare", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to update screenshare state"))
		return
	}
	slog.Debug("voice screenshare changed", "user_id", c.userID, "enabled", p.Enabled)

	h.broadcastVoiceStateUpdate(c)
}
