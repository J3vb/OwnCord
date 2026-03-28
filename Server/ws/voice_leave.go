package ws

import (
	"log/slog"
	"time"
)

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Gets old voiceChID from clearVoiceChID().
// 2. If was in voice: remove from DB (with retry), broadcast voice_leave.
// 3. Call livekit.RemoveParticipant (ignore errors — participant may already be gone).
func (h *Hub) handleVoiceLeave(c *Client) {
	oldChID := c.clearVoiceChID()
	if oldChID == 0 {
		slog.Debug("handleVoiceLeave no-op (already cleared)", "user_id", c.userID)
		return
	}

	username := ""
	if c.user != nil {
		username = c.user.Username
	}
	slog.Info("voice leave",
		"user_id", c.userID,
		"username", username,
		"channel_id", oldChID,
		"remote", c.remoteAddr,
	)

	if err := leaveVoiceChannelWithRetry(h, c.userID, oldChID); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
	}

	h.BroadcastToAll(buildVoiceLeave(oldChID, c.userID))

	// Remove from LiveKit (best-effort).
	if h.livekit != nil {
		if err := h.livekit.RemoveParticipant(oldChID, c.userID); err != nil {
			slog.Warn("handleVoiceLeave RemoveParticipant failed (may already be gone)",
				"err", err, "user_id", c.userID, "channel_id", oldChID)
		}
	}
}

// leaveVoiceChannelWithRetry attempts to remove the voice state from the DB
// with up to 3 retries and exponential backoff (100ms, 200ms, 400ms).
// Returns nil on success, the last error on exhaustion.
func leaveVoiceChannelWithRetry(h *Hub, userID int64, channelID int64) error {
	const maxRetries = 3
	delay := 100 * time.Millisecond

	for attempt := 1; attempt <= maxRetries; attempt++ {
		if err := h.db.LeaveVoiceChannel(userID); err != nil {
			slog.Warn("LeaveVoiceChannel failed, retrying",
				"err", err, "user_id", userID, "channel_id", channelID,
				"attempt", attempt, "max_retries", maxRetries)
			if attempt < maxRetries {
				time.Sleep(delay)
				delay *= 2
			} else {
				slog.Error("LeaveVoiceChannel exhausted retries — ghost state may persist",
					"err", err, "user_id", userID, "channel_id", channelID)
				return err
			}
		} else {
			if attempt > 1 {
				slog.Info("LeaveVoiceChannel succeeded on retry",
					"user_id", userID, "attempt", attempt)
			}
			return nil
		}
	}
	return nil
}
