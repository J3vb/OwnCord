package ws

import "log/slog"

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
		slog.Error("ws handleVoiceLeave LeaveVoiceChannel — ghost session may remain in DB",
			"err", leaveErr, "user_id", c.userID, "channel_id", oldChID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
		return
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
