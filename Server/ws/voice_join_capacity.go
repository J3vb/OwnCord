package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// voiceJoinCapacity is the cap a join is held to: the channel's
// voice_max_users, or 0 (uncapped) for a voice moderator in that channel. The
// test is permissions.AuthorizeVoiceModerator, the same authorizer behind
// can_moderate_voice and the voice_mod_* commands, so a per-channel deny of
// MUTE_MEMBERS takes the bypass away too. This mirrors Discord, where Move
// Members joins a full channel.
func voiceJoinCapacity(sub permissions.Subject, maxUsers int) int {
	if maxUsers > 0 && permissions.AuthorizeVoiceModerator(sub) == nil {
		return 0
	}
	return maxUsers
}

// voiceJoinSwitchCapacityOK is the advisory capacity pre-flight for the switch
// case, mirroring handleVoiceModMoveV2's pre-flight (voice_moderation.go):
// without it, voiceJoinLeaveCurrent tears the caller out of their current call
// before voiceJoinPersist's atomic check ever runs, so a switch to a full
// channel ends the old call for nothing (OC-0351). Same-channel re-join stays
// gated by ALREADY_JOINED in voiceJoinLeaveCurrent, not here — this only
// guards the destructive leave a genuine switch would trigger. The atomic
// JoinVoiceChannelIfCapacity check in voiceJoinPersist remains the authority
// for the race; this is advisory, exactly as in the move path. On refusal it
// has already sent the error frame and returns false.
func (h *Hub) voiceJoinSwitchCapacityOK(ctx context.Context, c *Client, channelID int64, maxUsers int, reqID string) bool {
	cur := c.voice.channel()
	if cur == 0 {
		// The user's call may be on another of their devices: joining here
		// moves it (voiceJoinMoveCall), which is the same destructive leave.
		if holder := h.voiceClient(c.userID); holder != nil && holder != c {
			cur = holder.voice.channel()
		}
	}
	if cur <= 0 || cur == channelID || maxUsers <= 0 {
		return true
	}
	count, err := h.voice.CountInChannel(ctx, channelID)
	if err != nil {
		slog.Error("ws voice_join: capacity pre-check failed", "err", err, "channel_id", channelID)
		voiceJoinFail(ctx, c, reqID, err, ErrCodeInternal, "failed to check channel capacity")
		return false
	}
	if count >= maxUsers {
		c.sendMsg(buildErrorMsgWithID(ErrCodeChannelFull, "voice channel is full", reqID))
		return false
	}
	return true
}
