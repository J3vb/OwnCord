package ws

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Voice leave reasons (SRE-M2): the machine-readable cause recorded on every
// "voice leave" log line, so an operator can tell one teardown path from
// another. Every caller of handleVoiceLeave / handleVoiceLeaveIfStillIn must
// pass exactly one of these — never an empty string.
const (
	// voiceLeaveReasonClient is an explicit client-sent voice_leave message.
	voiceLeaveReasonClient = "client"
	// voiceLeaveReasonSwitch is the destructive leave a channel switch runs
	// before joining the destination channel (voiceJoinLeaveCurrent).
	voiceLeaveReasonSwitch = "switch"
	// voiceLeaveReasonMoved is the leave of a call another of the user's
	// devices took over with its own voice_join (voiceJoinMoveCall).
	voiceLeaveReasonMoved = "moved"
	// voiceLeaveReasonDisconnect is the readPump teardown after the socket
	// dropped (serve_pumps.go).
	voiceLeaveReasonDisconnect = "disconnect"
	// voiceLeaveReasonHandshake is the post-auth handshake write failure path
	// (unregisterFailedHandshake, serve_auth.go).
	voiceLeaveReasonHandshake = "handshake"
	// voiceLeaveReasonModerator is a server-driven eviction: moderator kick,
	// move, or timeout (DisconnectFromVoice / disconnectFromVoiceIn).
	voiceLeaveReasonModerator = "moderator"
	// VoiceLeaveReasonDMLeave is a user leaving a group DM whose call they
	// are in, including the last participant closing it (api DM handler).
	VoiceLeaveReasonDMLeave = "dm_leave"
	// VoiceLeaveReasonDMRemoved is a user the group owner removed from a group
	// DM whose call they are in (api DM handler).
	VoiceLeaveReasonDMRemoved = "dm_removed"
	// VoiceLeaveReasonBlocked is a user evicted from a 1:1 DM call because
	// the other participant blocked them (api block handler).
	VoiceLeaveReasonBlocked = "blocked"
	// voiceLeaveReasonTokenRefresh is a refused voice_token_refresh whose
	// permission was revoked, which evicts rather than merely denying a token.
	voiceLeaveReasonTokenRefresh = "token_refresh"
	// voiceLeaveReasonRevoked is the voice permission revocation sweep
	// (sweepStaleVoiceEvictRevoked, hub_sweep.go).
	voiceLeaveReasonRevoked = "revoked"
	// voiceLeaveReasonReconciled is the polling reconciler removing a
	// membership whose SFU participant no longer exists (voice_reconcile.go).
	voiceLeaveReasonReconciled = "reconciled"
	// voiceLeaveReasonGraceExpired is the reconnect grace window elapsing
	// before a replacement socket arrived (voice_grace.go).
	voiceLeaveReasonGraceExpired = "grace_expired"
	// voiceLeaveReasonAFK is the AFK sweep moving a member who has been idle
	// past the timeout to the AFK channel (EvictForAFKMove, voice_afk.go).
	voiceLeaveReasonAFK = "afk"
)

// handleVoiceLeave processes an explicit voice_leave message or a disconnect.
// 1. Clears the slot and the voice-topic subscription (voiceTxn.clear).
// 2. If was in voice: remove from DB (with retry), broadcast voice_leave.
// 3. Remove the LiveKit participant in the background (best-effort).
//
// reason is the machine-readable cause, logged on the "voice leave" line; it is
// one of the voiceLeaveReason* constants (SRE-M2). Callers must never pass "".
// txn is the caller's Hub.begin(c.userID) handle.
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
// revocation sweep's DB-backed permission check) must not clear a newer
// membership committed while the decision was in flight — the same rule
// LeaveVoiceChannelIfMatch applies to the DB row.
// txn is the caller's Hub.begin(c.userID) handle.
func (h *Hub) handleVoiceLeaveIfStillIn(ctx context.Context, txn *voiceTxn, c *Client, chID int64, reason string) bool {
	snap, ok := txn.clearIfChannel(c, chID)
	if !ok {
		return false
	}
	h.finishVoiceLeave(ctx, txn, c, chID, snap.joinToken, reason)
	return true
}

// finishVoiceLeave is the shared tail of the leave paths, run after the
// client's voice state and topic subscription are cleared: DB row removal
// (with retry), voice_leave broadcast, key-holder re-election and LiveKit
// participant removal.
// txn is the caller's Hub.begin(c.userID) handle.
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

	// Audience = broadcastVoiceEvent's (READ ∪ still-in-the-room) plus the
	// leaver themselves: the caller has already cleared their client voice
	// state, so that union can no longer see them, yet for a server-initiated
	// eviction (revocation sweep, moderator kick/move, token-refresh refusal)
	// this voice_leave IS their only teardown signal.
	if announce {
		h.broadcastVoiceEventWithLeaver(ctx, oldChID, buildVoiceLeave(oldChID, c.userID), c.userID)
	}

	// Re-elect key holder now that this user has left the channel.
	h.updateKeyHolder(oldChID)

	// E2EE keys are now managed client-side via ECDH key exchange.
	// When a participant leaves, remaining clients rotate the room key
	// automatically — the server has no key material to clear.

	h.removeLiveKitParticipantAsync(ctx, oldChID, c.userID, oldJoinToken, "handleVoiceLeave")
}

// removeLiveKitParticipantAsync removes one exact LiveKit participant
// (best-effort) without blocking the caller. The caller is usually the
// client's read loop, and LiveKit can take seconds to answer for a
// participant that is closing its own session at the same moment (a client
// leave does both): it answers "no response from servers" after its 3 s
// routing timeout. Waiting on that in the read loop queued the client's next
// voice_join behind it, so an immediate rejoin stalled 3-6 s.
// The identity carries the join token, so a removal still in flight can never
// hit the session a quick rejoin creates. The removal must complete even if
// the connection drops, so it detaches from cancellation (values kept);
// shutdown cancels and joins it through the hub's background group, and the
// call is bounded by lkTimeout.
func (h *Hub) removeLiveKitParticipantAsync(ctx context.Context, channelID, userID int64, joinToken, caller string) {
	if h.livekit == nil {
		return
	}
	// Runs on the hub's group so StopHub joins it: a removal still in flight
	// when the hub stops is cancelled with the hub and waited for, and one
	// requested after the group closed is refused.
	admitted := h.background.Go(ctx, func(jobCtx context.Context) {
		// Still matters for struct-literal test hubs, whose nil group is
		// unowned and so never cancelled by the hub stop.
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

// voiceLeaveRetryTimeout bounds each background retry of the voice-state
// delete, so a wedged DB cannot hold the retry goroutine forever. Atomic so a
// test can shorten it while a grace timer left by an earlier test still reads it.
var voiceLeaveRetryTimeout atomic.Int64

func init() { voiceLeaveRetryTimeout.Store(int64(5 * time.Second)) }

// leaveVoiceChannelWithRetry attempts to remove the voice state from the DB
// using a channel-conditional delete. Only the row matching (userID, channelID)
// is removed — if the user has since moved to a different channel, the delete
// is a safe no-op. This prevents a race where a delayed retry could wipe a
// newer voice membership.
//
// The first attempt is synchronous. If it fails, subsequent retries run in a
// background goroutine with exponential backoff so the caller (readPump) is
// not blocked by time.Sleep. The goroutine respects ctx and the hub's stop
// channel to avoid leaking after shutdown.
// Returns nil on first-attempt success, the first error otherwise (retries
// continue in the background).
func leaveVoiceChannelWithRetry(ctx context.Context, txn *voiceTxn, channelID int64, joinToken string) error {
	h, userID := txn.h, txn.userID
	if joinToken == "" {
		slog.Warn("LeaveVoiceChannelIfMatch skipped due to missing join token",
			"user_id", userID, "channel_id", channelID)
		return nil
	}

	// Synchronous first attempt — channel-conditional delete. The retries below
	// call deleteJoinRow, which needs no lock handle, so the goroutine holds h
	// and userID and never the caller's txn.
	if _, err := txn.deleteRow(ctx, channelID, joinToken); err != nil {
		slog.Warn("LeaveVoiceChannelIfMatch failed, retrying in background",
			"err", err, "user_id", userID, "channel_id", channelID,
			"attempt", 1, "max_retries", 3)

		// Background retries — cancellable via hub stop only. The caller's ctx
		// is detached: on the webhook path it dies the moment the handler
		// returns, and on the voice_leave path it dies with the connection —
		// either would kill retry 2 before it ever ran, leaving a ghost
		// voice_states row holding a capacity slot until the 60s sweep.
		attemptTimeout := time.Duration(voiceLeaveRetryTimeout.Load())
		// The retries run on the hub's group: StopHub cancels and joins them,
		// and a leave that fails after the group closed gets no retry (the
		// sweep clears the row). Go only takes the group's leaf mutex and
		// returns; the job holds h and userID, never txn or any lock.
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
