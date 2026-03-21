package ws

import (
	"log/slog"
	"time"
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

// broadcastVoiceStateUpdate fetches the current voice state for the client
// and broadcasts it to all members of the voice channel they are in.
func (h *Hub) broadcastVoiceStateUpdate(c *Client) {
	state, err := h.db.GetVoiceState(c.userID)
	if err != nil {
		slog.Error("ws broadcastVoiceStateUpdate GetVoiceState", "err", err, "user_id", c.userID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to broadcast voice state update"))
		return
	}
	if state == nil {
		return // user not in a voice channel — nothing to broadcast
	}
	h.BroadcastToAll(buildVoiceState(*state))
}
