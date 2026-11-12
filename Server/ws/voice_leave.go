package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Voice leave reasons: the machine-readable cause on every "voice leave" log line. Every
// caller of handleVoiceLeave / handleVoiceLeaveIfStillIn passes exactly one, never "".
const (
	voiceLeaveReasonClient     = "client"
	voiceLeaveReasonSwitch     = "switch"
	voiceLeaveReasonMoved      = "moved"
	voiceLeaveReasonDisconnect = "disconnect"
	voiceLeaveReasonHandshake  = "handshake"
	voiceLeaveReasonModerator  = "moderator"
	// VoiceLeaveReasonDMLeave is a user leaving a group DM whose call they are in.
	VoiceLeaveReasonDMLeave = "dm_leave"
	// VoiceLeaveReasonDMRemoved is a user the group owner removed from a group DM whose call they are in.
	VoiceLeaveReasonDMRemoved = "dm_removed"
	// VoiceLeaveReasonBlocked is a user evicted from a 1:1 DM call because the other participant blocked
	// them.
	VoiceLeaveReasonBlocked      = "blocked"
	voiceLeaveReasonTokenRefresh = "token_refresh"
	voiceLeaveReasonRevoked      = "revoked"
	voiceLeaveReasonReconciled   = "reconciled"
	voiceLeaveReasonGraceExpired = "grace_expired"
	voiceLeaveReasonAFK          = "afk"
	voiceLeaveReasonUnconfirmed  = "unconfirmed"
)

// handleVoiceLeave processes an explicit voice_leave or a disconnect: clears the slot and
// voice-topic subscription, and if in voice removes the DB row (with retry), broadcasts
// voice_leave and removes the LiveKit participant in the background. reason is a
// voiceLeaveReason* constant. txn is the caller's Hub.begin(c.userID).
func (h *Hub) handleVoiceLeave(ctx context.Context, txn *voiceTxn, c *Client, reason string) {
	snap := txn.clear(c)
	if snap.chID == 0 {
		slog.Debug("handleVoiceLeave no-op (already cleared)", "user_id", c.userID, "reason", reason)
		return
	}
	h.finishVoiceLeave(ctx, txn, c, snap.chID, snap.joinToken, reason)
}

// handleVoiceLeaveIfStillIn is handleVoiceLeave conditioned on chID still being the
// client's voice channel, reporting whether it evicted. A decision against a snapshot (the
// revocation sweep) must not clear a newer membership (as LeaveVoiceChannelIfMatch does for the row).
func (h *Hub) handleVoiceLeaveIfStillIn(ctx context.Context, txn *voiceTxn, c *Client, chID int64, reason string) bool {
	snap, ok := txn.clearIfChannel(c, chID)
	if !ok {
		return false
	}
	h.finishVoiceLeave(ctx, txn, c, chID, snap.joinToken, reason)
	return true
}

// finishVoiceLeave is the shared tail of the leave paths: DB row removal (with retry),
// voice_leave broadcast, key-holder re-election and LiveKit removal.
func (h *Hub) finishVoiceLeave(ctx context.Context, txn *voiceTxn, c *Client, oldChID int64, oldJoinToken, reason string) {
	h.finishVoiceLeaveAnnounce(ctx, txn, c, oldChID, oldJoinToken, reason, true)
}

// finishVoiceLeaveAnnounce is finishVoiceLeave with the broadcast optional. announce=false
// is the same-channel call move: the user stays in the room, so no voice_leave that a
// client would apply to the new join, and the row stays for the join's upsert (member lock held).
func (h *Hub) finishVoiceLeaveAnnounce(ctx context.Context, txn *voiceTxn, c *Client, oldChID int64, oldJoinToken, reason string, announce bool) {
	username := ""
	if c.user != nil {
		username = c.user.Username
	}
	slog.Info("voice leave",
		"user_id", c.userID,
		"username", username,
		"channel_id", oldChID,
		"reason", reason,
		"remote", c.remoteAddr,
	)

	if announce {
		if err := leaveVoiceChannelWithRetry(ctx, txn, oldChID, oldJoinToken); err != nil {
			c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
		}
	}

	// Audience is broadcastVoiceEvent's plus the leaver: their client voice state is already
	// cleared, yet for a server-initiated eviction this is their only teardown signal.
	if announce {
		h.broadcastVoiceEventWithLeaver(ctx, oldChID, buildVoiceLeave(oldChID, c.userID), c.userID)
	}

	h.updateKeyHolder(oldChID)

	// E2EE keys are client-side (ECDH): remaining clients rotate on leave; no key material here.

	h.removeLiveKitParticipantAsyncFor(ctx, oldChID, c.userID, oldJoinToken, "handleVoiceLeave", voiceLeaveIsOwn(reason))
}

// voiceLeaveIsOwn reports whether the client asked for the leave itself (checked by the
// removed-identity watch on its slower cadence); drops, takeovers and evictions are not.
func voiceLeaveIsOwn(reason string) bool {
	switch reason {
	case voiceLeaveReasonClient, voiceLeaveReasonSwitch, VoiceLeaveReasonDMLeave:
		return true
	}
	return false
}

// removeLiveKitParticipantAsync removes one exact participant (best-effort) without
// blocking the caller, usually the read loop: LiveKit can take 3 s+ to answer for a
// participant closing its own session, which stalled an immediate rejoin 3-6 s. The identity
// carries the join token, so a removal never hits a quick rejoin's session. Detached from
// cancellation (values kept); joined via the hub's background group, bounded by lkTimeout.
func (h *Hub) removeLiveKitParticipantAsync(ctx context.Context, channelID, userID int64, joinToken, caller string) {
	h.removeLiveKitParticipantAsyncFor(ctx, channelID, userID, joinToken, caller, false)
}

// removeLiveKitParticipantAsyncFor is removeLiveKitParticipantAsync; ownLeave marks a
// client-requested leave (RemoveParticipantAfterOwnLeave).
func (h *Hub) removeLiveKitParticipantAsyncFor(ctx context.Context, channelID, userID int64, joinToken, caller string, ownLeave bool) {
	if h.livekit == nil {
		return
	}
	// Runs on the hub's group so StopHub cancels and joins it; one requested after the group
	// closed is refused.
	admitted := h.lifecycle.background.Go(ctx, func(jobCtx context.Context) {
		// Struct-literal test hubs have a nil, unowned group that hub stop never cancels.
		select {
		case <-h.stop:
			return
		default:
		}
		lkCtx, cancel := context.WithTimeout(jobCtx, lkTimeout)
		defer cancel()
		remove := h.livekit.RemoveParticipant
		if ownLeave {
			remove = h.livekit.RemoveParticipantAfterOwnLeave
		}
		if err := remove(lkCtx, channelID, userID, joinToken); err != nil {
			slog.Warn("RemoveParticipant failed (may already be gone)",
				"caller", caller, "err", err, "user_id", userID, "channel_id", channelID)
		}
	})
	if !admitted {
		slog.Info("RemoveParticipant skipped, hub is stopping",
			"caller", caller, "user_id", userID, "channel_id", channelID)
	}
}

// voiceLeaveRetryTimeout bounds each background retry so a wedged DB cannot hold it forever.
// Atomic so a test can shorten it while an earlier test's grace timer still reads it.
var voiceLeaveRetryTimeout atomic.Int64

func init() { voiceLeaveRetryTimeout.Store(int64(5 * time.Second)) }

// leaveVoiceChannelWithRetry removes the voice state with a channel-conditional delete, so
// a user who has since moved channel is a safe no-op and a delayed retry cannot wipe a newer
// membership. The first attempt is synchronous; on failure retries run in the background
// with exponential backoff, honouring ctx and hub stop. Returns nil on first-attempt
// success, else the first error.
func leaveVoiceChannelWithRetry(ctx context.Context, txn *voiceTxn, channelID int64, joinToken string) error {
	h, userID := txn.h, txn.userID
	if joinToken == "" {
		slog.Warn("LeaveVoiceChannelIfMatch skipped due to missing join token",
			"user_id", userID, "channel_id", channelID)
		return nil
	}

	// Synchronous first attempt. Retries call deleteJoinRow (no lock handle), so the goroutine never holds
	// the caller's txn.
	if _, err := txn.deleteRow(ctx, channelID, joinToken); err != nil {
		slog.Warn("LeaveVoiceChannelIfMatch failed, retrying in background",
			"err", err, "user_id", userID, "channel_id", channelID,
			"attempt", 1, "max_retries", 3)

		// Retries are cancellable by hub stop only. The caller's ctx is detached (it dies with the
		// handler or connection), or retry 2 would never run and a ghost row would hold a capacity
		// slot until the 60s sweep.
		attemptTimeout := time.Duration(voiceLeaveRetryTimeout.Load())
		// Retries run on the hub's group: StopHub joins them, and a leave failing after the group
		// closed gets no retry (the sweep clears the row). The job holds h and userID, never txn or a lock.
		admitted := h.lifecycle.background.Go(ctx, func(retryCtx context.Context) {
			const maxRetries = 3
			delay := 200 * time.Millisecond

			for attempt := 2; attempt <= maxRetries; attempt++ {
				select {
				case <-h.stop:
					slog.Info("LeaveVoiceChannelIfMatch retry cancelled (hub stop)",
						"user_id", userID, "channel_id", channelID, "attempt", attempt)
					return
				case <-retryCtx.Done():
					slog.Info("LeaveVoiceChannelIfMatch retry cancelled (hub stop)",
						"user_id", userID, "channel_id", channelID, "attempt", attempt)
					return
				case <-time.After(delay):
				}
				delay *= 2

				attemptCtx, cancel := context.WithTimeout(retryCtx, attemptTimeout)
				_, retryErr := h.voiceHub.reg.deleteJoinRow(attemptCtx, h, userID, channelID, joinToken)
				cancel()
				if retryErr != nil {
					if retryCtx.Err() != nil {
						return
					}
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
		})
		if !admitted {
			slog.Info("LeaveVoiceChannelIfMatch retries skipped, hub is stopping",
				"user_id", userID, "channel_id", channelID)
		}

		return err
	}
	return nil
}
