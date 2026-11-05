package ws

import (
	"context"
	"fmt"
	"log/slog"
)

// muteParticipantHookForTest, when non-nil, replaces the real LiveKit call.
// Test-only: the voice-mod lock's concurrency tests need a working SFU to prove a
// real mute survives a racing unmute, and h.livekit is nil in other ws tests, which
// would make "muted" unreachable.
var muteParticipantHookForTest func(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error

// MuteParticipant reconciles the target's publication permissions at the SFU.
// Reads h.livekit at call time so SetLiveKit's late wiring is picked up. Callers
// hold voiceHub.mod across their state write and this permission update.
func (h *Hub) MuteParticipant(ctx context.Context, channelID, userID int64, voiceJoinToken string, muted bool) error {
	if muteParticipantHookForTest != nil {
		return muteParticipantHookForTest(ctx, channelID, userID, voiceJoinToken, muted)
	}
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, voiceJoinToken)
}

// SetServerMuteLocked applies or clears the manual moderator mute, running the DB
// write and its paired LiveKit call under the same per-user lock the timeout
// voice half uses (MuteForTimeout / UnmuteForTimeout); a lock only one path took
// would serialize nothing. matched means as VoiceStore.SetServerMute's result
// (false: the row moved off channelID since authorization); joinedAt is the
// session's join token for the caller's SFU/broadcast use.
//
// An SFU failure is returned as errVoiceMediaPending; the persisted desired state
// is retained for retry and periodic reconciliation.
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
		// Publish the saved desired state even though the caller returns an error: error
		// results short-circuit ordinary handler events and the client must know these
		// flags while the SFU update awaits retry.
		h.broadcastVoiceMuteState(ctx, userID, channelID, joinedAt, muted)
		return matched, joinedAt, fmt.Errorf("%w: %w", errVoiceMediaPending, mpErr)
	}
	return matched, joinedAt, nil
}

// DisconnectFromVoice runs the hub's voice-leave routine for another user's
// connection (DB row, LiveKit participant, topic unsubscribe, key-holder
// re-election, voice_leave), the one implementation shared with disconnect and
// channel-switch. Reports false when the user has no connection on this node.
func (h *Hub) DisconnectFromVoice(ctx context.Context, userID int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	// The call is on one device: that connection leaves. With none holding a call the
	// only membership left may be a parked one.
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

// DisconnectFromVoiceInChannel is DisconnectFromVoice conditioned on the channel
// the caller authorized against (voiceChannelDisconnector). The comparison and
// clear happen together under the client's voiceMu (handleVoiceLeaveIfStillIn ->
// voiceTxn.clearIfChannel), so a channel switch committed on the target's goroutine
// after the moderator's checks either loses the race or is left untouched, never
// evicted in place of the checked channel. False in both cases, which callers
// treat as not connected. reason is the voiceLeaveReason* constant for the log line.
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

// SetPendingVoiceModFlags stashes a moderator-imposed mute/deafen on userID's voice
// connection under the member lock (voicePendingModFlagsSetter). Reports false
// when the user has no connection on this node: nowhere to stash, and no re-join
// here to consume it.
func (h *Hub) SetPendingVoiceModFlags(userID int64, serverMuted, serverDeafened bool, serverMutedBy *int64) bool {
	txn := h.begin(userID)
	defer txn.end()
	if !serverMuted && !serverDeafened {
		// A clear also forgets a move kept for a parked session: the move it
		// belonged to did not complete.
		h.voiceHub.reg.voiceGrace.dropParkedModMove(userID)
	}
	// The stash rides the connection holding the call: its eviction and the target's
	// re-join consume it.
	c := h.voiceClient(userID)
	if c == nil {
		// No device holds a call: the newest connection takes the stash; the next
		// voice_join from any device collects it (voiceJoinMoveCall / voiceJoinLeaveCurrent).
		conns := h.clientsOf(userID)
		if len(conns) == 0 {
			return false
		}
		c = conns[len(conns)-1]
	}
	txn.stashModFlags(c, serverMuted, serverDeafened, serverMutedBy)
	return true
}
