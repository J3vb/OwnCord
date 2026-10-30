package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Voice leave reasons: the machine-readable cause on every "voice leave" log line, to
// tell teardown paths apart. Every caller of handleVoiceLeave /
// handleVoiceLeaveIfStillIn must pass exactly one, never "".
const (
	// voiceLeaveReasonClient is an explicit client-sent voice_leave.
	voiceLeaveReasonClient = "client"
	// voiceLeaveReasonSwitch is the leave a channel switch runs before joining the
	// destination (voiceJoinLeaveCurrent).
	voiceLeaveReasonSwitch = "switch"
	// voiceLeaveReasonMoved is the leave of a call another of the user's devices took
	// over (voiceJoinMoveCall).
	voiceLeaveReasonMoved = "moved"
	// voiceLeaveReasonDisconnect is the readPump teardown after the socket dropped.
	voiceLeaveReasonDisconnect = "disconnect"
	// voiceLeaveReasonHandshake is the post-auth handshake write failure path
	// (unregisterFailedHandshake).
	voiceLeaveReasonHandshake = "handshake"
	// voiceLeaveReasonModerator is a server-driven eviction: moderator kick, move or
	// timeout (DisconnectFromVoice / disconnectFromVoiceIn).
	voiceLeaveReasonModerator = "moderator"
	// VoiceLeaveReasonDMLeave is a user leaving a group DM whose call they are in,
	// including the last participant closing it.
	VoiceLeaveReasonDMLeave = "dm_leave"
	// VoiceLeaveReasonDMRemoved is a user the group owner removed from a group DM whose
	// call they are in.
	VoiceLeaveReasonDMRemoved = "dm_removed"
	// VoiceLeaveReasonBlocked is a user evicted from a 1:1 DM call because the other
	// participant blocked them.
	VoiceLeaveReasonBlocked = "blocked"
	// voiceLeaveReasonTokenRefresh is a voice_token_refresh refused for a revoked
	// permission, which evicts rather than just denying a token.
	voiceLeaveReasonTokenRefresh = "token_refresh"
	// voiceLeaveReasonRevoked is the voice permission revocation sweep.
	voiceLeaveReasonRevoked = "revoked"
	// voiceLeaveReasonReconciled is the polling reconciler removing a membership whose
	// SFU participant no longer exists.
	voiceLeaveReasonReconciled = "reconciled"
	// voiceLeaveReasonGraceExpired is the reconnect grace window elapsing before a
	// replacement socket arrived.
	voiceLeaveReasonGraceExpired = "grace_expired"
	// voiceLeaveReasonAFK is the AFK sweep moving a member idle past the timeout to the
	// AFK channel (EvictForAFKMove).
	voiceLeaveReasonAFK = "afk"
)

// handleVoiceLeave processes an explicit voice_leave or a disconnect: clears the
// slot and voice-topic subscription (voiceTxn.clear); if the client was in voice,
// removes the DB row (with retry) and broadcasts voice_leave; then removes the
// LiveKit participant in the background (best-effort). reason is one of the
// voiceLeaveReason* constants, never "". txn is the caller's Hub.begin(c.userID).
func (h *Hub) handleVoiceLeave(ctx context.Context, txn *voiceTxn, c *Client, reason string) {
	snap := txn.clear(c)
	if snap.chID == 0 {
		slog.Debug("handleVoiceLeave no-op (already cleared)", "user_id", c.userID, "reason", reason)
		return
	}
	h.finishVoiceLeave(ctx, txn, c, snap.chID, snap.joinToken, reason)
}

// handleVoiceLeaveIfStillIn is handleVoiceLeave conditioned on the channel: it
// evicts only if chID is still the client's current voice channel, reporting
// whether it did. An eviction decided against a snapshotted channel (the
// revocation sweep) must not clear a newer membership committed meanwhile, the rule
// LeaveVoiceChannelIfMatch applies to the DB row. txn is the caller's Hub.begin(c.userID).
func (h *Hub) handleVoiceLeaveIfStillIn(ctx context.Context, txn *voiceTxn, c *Client, chID int64, reason string) bool {
	snap, ok := txn.clearIfChannel(c, chID)
	if !ok {
		return false
	}
	h.finishVoiceLeave(ctx, txn, c, chID, snap.joinToken, reason)
	return true
}

// finishVoiceLeave is the shared tail of the leave paths, after the client's voice
// state and topic subscription are cleared: DB row removal (with retry),
// voice_leave broadcast, key-holder re-election and LiveKit participant removal.
// txn is the caller's Hub.begin(c.userID).
func (h *Hub) finishVoiceLeave(ctx context.Context, txn *voiceTxn, c *Client, oldChID int64, oldJoinToken, reason string) {
	h.finishVoiceLeaveAnnounce(ctx, txn, c, oldChID, oldJoinToken, reason, true)
}

// finishVoiceLeaveAnnounce is finishVoiceLeave with the voice_leave broadcast
// optional. announce=false is the same-channel call move: the user stays in the
// room (their new device is about to take the slot), so no voice_leave goes out
// that a client would apply to the new join.
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

	if err := leaveVoiceChannelWithRetry(ctx, txn, oldChID, oldJoinToken); err != nil {
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "voice leave failed — please rejoin if issues persist"))
	}

	// Audience = broadcastVoiceEvent's (READ plus still-in-the-room) plus the leaver:
	// the caller already cleared their client voice state so that union can no longer
	// see them, yet for a server-initiated eviction (revocation sweep, moderator
	// kick/move, token-refresh refusal) this voice_leave is their only teardown signal.
	if announce {
		h.broadcastVoiceEventWithLeaver(ctx, oldChID, buildVoiceLeave(oldChID, c.userID), c.userID)
	}

	h.updateKeyHolder(oldChID)

	// E2EE keys are managed client-side via ECDH: remaining clients rotate the room key
	// when a participant leaves; the server has no key material to clear.

	h.removeLiveKitParticipantAsync(ctx, oldChID, c.userID, oldJoinToken, "handleVoiceLeave")
}

// removeLiveKitParticipantAsync removes one exact LiveKit participant (best-effort)
// without blocking the caller, usually the client's read loop. LiveKit can take
// seconds to answer for a participant closing its own session at the same moment (a
// client leave does both): it answers "no response from servers" after its 3 s
// routing timeout. Waiting on that in the read loop queued the client's next
// voice_join behind it, stalling an immediate rejoin 3-6 s. The identity carries
// the join token, so a removal in flight never hits the session a quick rejoin
// creates. The removal must complete even if the connection drops, so it detaches
// from cancellation (values kept); shutdown cancels and joins it through the hub's
// background group, and the call is bounded by lkTimeout.
func (h *Hub) removeLiveKitParticipantAsync(ctx context.Context, channelID, userID int64, joinToken, caller string) {
	if h.livekit == nil {
		return
	}
	// Runs on the hub's group so StopHub joins it: a removal in flight at stop is
	// cancelled and waited for, and one requested after the group closed is refused.
	// requested after the group closed is refused.
	admitted := h.background.Go(ctx, func(jobCtx context.Context) {
		// Still matters for struct-literal test hubs, whose nil group is unowned and never
		// cancelled by hub stop.
		select {
		case <-h.stop:
			return
		default:
		}
		lkCtx, cancel := context.WithTimeout(jobCtx, lkTimeout)
		defer cancel()
		if err := h.livekit.RemoveParticipant(lkCtx, channelID, userID, joinToken); err != nil {
			slog.Warn("RemoveParticipant failed (may already be gone)",
				"caller", caller, "err", err, "user_id", userID, "channel_id", channelID)
		}
	})
	if !admitted {
		slog.Info("RemoveParticipant skipped, hub is stopping",
			"caller", caller, "user_id", userID, "channel_id", channelID)
	}
}

// voiceLeaveRetryTimeout bounds each background retry of the voice-state delete so a
// wedged DB cannot hold the retry goroutine forever. Atomic so a test can shorten
// it while a grace timer from an earlier test still reads it.
var voiceLeaveRetryTimeout atomic.Int64

func init() { voiceLeaveRetryTimeout.Store(int64(5 * time.Second)) }

// leaveVoiceChannelWithRetry removes the voice state from the DB with a
// channel-conditional delete: only the row matching (userID, channelID) goes, so if
// the user has since moved channel it is a safe no-op and a delayed retry cannot
// wipe a newer membership. The first attempt is synchronous; on failure retries run
// in a background goroutine with exponential backoff so the caller (readPump) is not
// blocked, honouring ctx and the hub's stop channel. Returns nil on first-attempt
// success, else the first error (retries continue in the background).
func leaveVoiceChannelWithRetry(ctx context.Context, txn *voiceTxn, channelID int64, joinToken string) error {
	h, userID := txn.h, txn.userID
	if joinToken == "" {
		slog.Warn("LeaveVoiceChannelIfMatch skipped due to missing join token",
			"user_id", userID, "channel_id", channelID)
		return nil
	}

	// Synchronous first attempt. The retries call deleteJoinRow, which needs no lock
	// handle, so the goroutine holds h and userID and never the caller's txn.
	if _, err := txn.deleteRow(ctx, channelID, joinToken); err != nil {
		slog.Warn("LeaveVoiceChannelIfMatch failed, retrying in background",
			"err", err, "user_id", userID, "channel_id", channelID,
			"attempt", 1, "max_retries", 3)

		// Background retries are cancellable via hub stop only. The caller's ctx is
		// detached: on the webhook path it dies when the handler returns, on voice_leave
		// with the connection; either would kill retry 2 before it ran, leaving a ghost
		// voice_states row holding a capacity slot until the 60s sweep.
		attemptTimeout := time.Duration(voiceLeaveRetryTimeout.Load())
		// The retries run on the hub's group: StopHub cancels and joins them, and a leave
		// failing after the group closed gets no retry (the sweep clears the row). Go only
		// takes the group's leaf mutex and returns; the job holds h and userID, never txn or
		// any lock.
		admitted := h.background.Go(ctx, func(retryCtx context.Context) {
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
				_, retryErr := h.voiceReg.deleteJoinRow(attemptCtx, h, userID, channelID, joinToken)
				cancel()
				if retryErr != nil {
					if retryCtx.Err() != nil {
						// The group cancelled the attempt: a hub stop, not a failure.
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
