package ws

import (
	"context"
	"log/slog"
)

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
func (h *Hub) voiceJoinSwitchCapacityOK(ctx context.Context, c *Client, channelID int64, maxUsers int) bool {
	cur := c.getVoiceChID()
	if cur <= 0 || cur == channelID || maxUsers <= 0 {
		return true
	}
	count, err := h.voice.CountInChannel(ctx, channelID)
	if err != nil {
		slog.Error("ws voice_join: capacity pre-check failed", "err", err, "channel_id", channelID)
		c.sendMsg(buildErrorMsg(ErrCodeInternal, "failed to check channel capacity"))
		return false
	}
	if count >= maxUsers {
		c.sendMsg(buildErrorMsg(ErrCodeChannelFull, "voice channel is full"))
		return false
	}
	return true
}
