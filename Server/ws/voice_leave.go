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

	// Unsubscribe from voice topic.
	h.pubsub.Unsubscribe(c, VoiceTopic(oldChID))

	if err := leaveVoiceChannelWithRetry(ctx, h, c.userID, oldChID, oldJoinToken); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
	}

	h.broadcastVoiceEvent(ctx, oldChID, buildVoiceLeave(oldChID, c.userID))

	// Re-elect key holder now that this user has left the channel.
	h.updateKeyHolder(oldChID)

	// E2EE keys are now managed client-side via ECDH key exchange.
	// When a participant leaves, remaining clients rotate the room key
	// automatically — the server has no key material to clear.

	// Remove from LiveKit (best-effort).
	if h.livekit != nil {
		if err := h.livekit.RemoveParticipant(ctx, oldChID, c.userID, oldJoinToken); err != nil {
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
// not blocked by time.Sleep. The goroutine respects ctx and the hub's stop
// channel to avoid leaking after shutdown (BUG-086).
// Returns nil on first-attempt success, the first error otherwise (retries
// continue in the background).
func leaveVoiceChannelWithRetry(ctx context.Context, h *Hub, userID int64, channelID int64, joinToken string) error {
	if joinToken == "" {
		slog.Warn("LeaveVoiceChannelIfMatch skipped due to missing join token",
			"user_id", userID, "channel_id", channelID)
		return nil
	}

	// Synchronous first attempt — channel-conditional delete.
	if _, err := h.db.LeaveVoiceChannelIfMatch(ctx, userID, channelID, joinToken); err != nil {
		slog.Warn("LeaveVoiceChannelIfMatch failed, retrying in background",
			"err", err, "user_id", userID, "channel_id", channelID,
			"attempt", 1, "max_retries", 3)

		// Background retries — cancellable via hub stop only. The caller's ctx
		// is detached: on the webhook path it dies the moment the handler
		// returns, and on the voice_leave path it dies with the connection —
		// either would kill retry 2 before it ever ran, leaving a ghost
		// voice_states row holding a capacity slot until the 60s sweep.
		go func() {
			retryCtx := context.WithoutCancel(ctx)
			const maxRetries = 3
			delay := 200 * time.Millisecond

			for attempt := 2; attempt <= maxRetries; attempt++ {
				select {
				case <-h.stop:
					slog.Info("LeaveVoiceChannelIfMatch retry cancelled (hub stop)",
						"user_id", userID, "channel_id", channelID, "attempt", attempt)
					return
				case <-time.After(delay):
				}
				delay *= 2

				if _, retryErr := h.db.LeaveVoiceChannelIfMatch(retryCtx, userID, channelID, joinToken); retryErr != nil {
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
