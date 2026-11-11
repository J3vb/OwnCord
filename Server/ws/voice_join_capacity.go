package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// voiceJoinCapacity is the cap a join is held to: the channel's voice_max_users, or 0
// (uncapped) for a voice moderator there. The test is permissions.AuthorizeVoiceModerator,
// the authorizer behind can_moderate_voice and voice_mod_*, so a per-channel deny of
// MUTE_MEMBERS removes the bypass too. The join handler also passes 0 for a same-channel
// take-over, which re-takes the slot the user's own call just freed.
func voiceJoinCapacity(sub permissions.Subject, maxUsers int) int {
	if maxUsers > 0 && permissions.AuthorizeVoiceModerator(sub) == nil {
		return 0
	}
	return maxUsers
}

// voiceJoinSwitchCapacityOK is the advisory capacity pre-flight for the switch case,
// mirroring handleVoiceModMoveV2's: without it voiceJoinLeaveCurrent tears the caller out of
// their current call before voiceJoinPersist's atomic check runs, ending the old call for
// nothing on a switch to a full channel. Same-channel re-join is gated by ALREADY_JOINED
// elsewhere; this guards only the destructive leave. The atomic
// JoinVoiceChannelIfCapacity check remains the authority for the race. On refusal it has
// sent the error frame and returns false.
func (h *Hub) voiceJoinSwitchCapacityOK(ctx context.Context, c *Client, channelID int64, maxUsers int, reqID string) bool {
	cur := c.voice.channel()
	if cur == 0 {
		// The user's call may be on another device: joining here moves it (voiceJoinMoveCall), the same
		// destructive leave.
		if holder := h.voiceClient(c.userID); holder != nil && holder != c {
			cur = holder.voice.channel()
		} else if e := h.voiceHub.reg.voiceGrace.get(c.userID); e != nil {
			cur = e.snap.chID
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
