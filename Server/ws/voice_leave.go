package ws

import (
	"context"
	"log/slog"
	"time"
)

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Gets old voiceChID from clearVoiceChID().
// 2. If was in voice: remove from DB (with retry), broadcast voice_leave.
// 3. Call livekit.RemoveParticipant (ignore errors — participant may already be gone).
func (h *Hub) handleVoiceLeave(ctx context.Context, c *Client) {
	oldChID, oldJoinToken := c.clearVoiceState()
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

	if err := leaveVoiceChannelWithRetry(h, c.userID, oldChID, oldJoinToken); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
	}

	h.BroadcastToAll(buildVoiceLeave(oldChID, c.userID))

	// Remove from LiveKit (best-effort).
	if h.livekit != nil {
		if err := h.livekit.RemoveParticipant(oldChID, c.userID, oldJoinToken); err != nil {
			slog.Warn("handleVoiceLeave RemoveParticipant failed (may already be gone)",
				"err", err, "user_id", c.userID, "channel_id", oldChID)
		}
	}
}

// leaveVoiceChannelWithRetry attempts to remove the voice state from the DB
// using a channel-conditional delete. Only the row matching (userID, channelID)
// is removed — if the user has since moved to a different channel, the delete
// is a safe no-op. This prevents a race where a delayed retry could wipe a
// newer voice membership.
//
// The first attempt is synchronous. If it fails, subsequent retries run in a
// background goroutine with exponential backoff so the caller (readPump) is
// not blocked by time.Sleep.
// Returns nil on first-attempt success, the first error otherwise (retries
// continue in the background).
func leaveVoiceChannelWithRetry(h *Hub, userID int64, channelID int64, joinToken string) error {
	if joinToken == "" {
		slog.Warn("LeaveVoiceChannelIfMatch skipped due to missing join token",
			"user_id", userID, "channel_id", channelID)
		return nil
	}

	// Synchronous first attempt — channel-conditional delete.
	if _, err := h.db.LeaveVoiceChannelIfMatch(userID, channelID, joinToken); err != nil {
		slog.Warn("LeaveVoiceChannelIfMatch failed, retrying in background",
			"err", err, "user_id", userID, "channel_id", channelID,
			"attempt", 1, "max_retries", 3)

		// Background retries so the readPump goroutine is not blocked.
		go func() {
			const maxRetries = 3
			delay := 200 * time.Millisecond

			for attempt := 2; attempt <= maxRetries; attempt++ {
				time.Sleep(delay)
				delay *= 2

				if _, retryErr := h.db.LeaveVoiceChannelIfMatch(userID, channelID, joinToken); retryErr != nil {
					slog.Warn("LeaveVoiceChannelIfMatch retry failed",
						"err", retryErr, "user_id", userID, "channel_id", channelID,
						"attempt", attempt, "max_retries", maxRetries)
					if attempt == maxRetries {
						slog.Error("LeaveVoiceChannelIfMatch exhausted retries — ghost state may persist",
							"err", retryErr, "user_id", userID, "channel_id", channelID)
					}
				} else {
					slog.Info("LeaveVoiceChannelIfMatch succeeded on retry",
						"user_id", userID, "channel_id", channelID, "attempt", attempt)
					return
				}
			}
		}()

		return err
	}
	return nil
}
