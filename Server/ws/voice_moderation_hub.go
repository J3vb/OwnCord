package ws

import (
	"context"
	"fmt"
	"log/slog"
)

// muteParticipantHookForTest replaces the real LiveKit call. Test-only: the voice-mod lock
// concurrency tests need a working SFU, and h.livekit is nil in other ws tests.
var muteParticipantHookForTest func(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error

// MuteParticipant reconciles the target's publication permissions at the SFU, reading h.livekit at call time
// (late SetLiveKit wiring). Callers hold voiceHub.mod across their state write and this update.
func (h *Hub) MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error {
	if muteParticipantHookForTest != nil {
		return muteParticipantHookForTest(ctx, channelID, userID, voiceJoinToken, muted)
	}
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, voiceJoinToken)
}

// SetServerMuteLocked applies or clears the manual moderator mute, running the DB write and
// its paired LiveKit call under the same per-user lock the timeout voice half uses
// (MuteForTimeout / UnmuteForTimeout); a lock only one path took would serialize nothing.
// matched is as VoiceStore.SetServerMute's result (false: the row moved off channelID);
// joinedAt is the session's join token. An SFU failure returns errVoiceMediaPending; the
// persisted state is retained for retry and reconciliation.
func (h *Hub) SetServerMuteLocked(ctx context.Context, userID, channelID int64, muted bool) (matched bool, joinedAt string, err error) {
	unlock := h.voiceHub.mod.Lock(userID)
	defer unlock()

	matched, err = h.voice.SetServerMute(ctx, userID, channelID, muted)
	if err != nil || !matched {
		return matched, "", err
	}
	if state, stateErr := h.voice.State(ctx, userID); stateErr == nil && state != nil {
		joinedAt = state.JoinedAt
	}
	if mpErr := h.MuteParticipant(ctx, channelID, userID, joinedAt, muted); mpErr != nil {
		slog.Warn("ws SetServerMuteLocked MuteParticipant failed", "err", mpErr, "user_id", userID, "channel_id", channelID)
		// Publish the saved state even though the caller returns an error: error results short-circuit
		// ordinary handler events and the client must know the flags while the SFU update awaits retry.
		h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, muted)
		return matched, joinedAt, fmt.Errorf("%w: %w", errVoiceMediaPending, mpErr)
	}
	return matched, joinedAt, nil
}

// DisconnectFromVoice runs the hub's voice-leave routine for another user's connection (the one
// implementation shared with disconnect and channel-switch). False when the user has no connection on this
// node.
func (h *Hub) DisconnectFromVoice(ctx context.Context, userID int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	// The call is on one device: that connection leaves. With none holding a call the only membership left
	// may be a parked one.
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		left := h.leaveParkedVoice(ctx, txn, txn.takeParked(0), voiceLeaveReasonModerator)
		return left || h.isConnected(userID)
	}
	h.handleVoiceLeave(ctx, txn, c, voiceLeaveReasonModerator)
	h.noteModeratorExit(userID, c)
	return true
}

// DisconnectFromVoiceInChannel is DisconnectFromVoice conditioned on the channel the caller
// authorized against (voiceChannelDisconnector). Comparison and clear happen together under
// the client's voiceMu (handleVoiceLeaveIfStillIn -> voiceTxn.clearIfChannel), so a channel
// switch committed after the moderator's checks either loses the race or is untouched, never
// evicted in place of the checked channel. False in both cases (callers treat as not
// connected). reason is the voiceLeaveReason* constant for the log line.
func (h *Hub) DisconnectFromVoiceInChannel(ctx context.Context, userID, channelID int64, reason string) bool {
	txn := h.begin(userID)
	defer txn.end()
	c := h.voiceClient(userID)
	if c == nil {
		h.noteModeratorExit(userID, nil)
		return h.leaveParkedVoice(ctx, txn, txn.takeParked(channelID), reason)
	}
	left := h.handleVoiceLeaveIfStillIn(ctx, txn, c, channelID, reason)
	if left {
		h.noteModeratorExit(userID, c)
	}
	return left
}

// SetPendingVoiceModFlags stashes a moderator mute/deafen on userID's voice connection under
// the member lock (voicePendingModFlagsSetter). False when the user has no connection on
// this node: nowhere to stash and no re-join here to consume it.
func (h *Hub) SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	if !serverMuted && !serverDeafened {
		// A clear also forgets a move kept for a parked session: the move did not complete.
		h.voiceHub.reg.voiceGrace.dropParkedModMove(userID)
	}
	// The stash rides the connection holding the call: its eviction and the target's re-join consume it.
	c := h.voiceClient(userID)
	if c == nil {
		// No device holds a call: the newest connection takes the stash; the next voice_join from any device
		// collects it.
		conns := h.clientsOf(userID)
		if len(conns) == 0 {
			return false
		}
		c = conns[len(conns)-1]
	}
	txn.stashModFlags(c, serverMuted, serverDeafened, serverMutedBy)
	return true
}
