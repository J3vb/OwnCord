package ws

import (
	"context"
	"log/slog"
)

// SendDMVoiceRoster tells userID who is in channelID's live call, one sequenced
// voice_state per participant. A user added to a group DM mid-call is outside the
// voice fan-out, so without this they see no roster until a full ready.
// The REST handler calls it after the added user's dm_channel_open from the same
// goroutine, so the open (high queue) arrives first. The read runs before any hub
// lock; a failed read logs and sends nothing, and the add stays committed.
// A leave taking its seq between the read and these sends leaves a stale state in
// the replay ring until the next full ready; the client drops earlier rosters
// when it first learns of the group.
func (h *Hub) SendDMVoiceRoster(ctx context.Context, userID, channelID int64) {
	if h.voice == nil {
		return
	}
	states, err := h.voice.ChannelStates(ctx, channelID)
	if err != nil {
		slog.Warn("dm voice roster: read channel states failed", "err", err, "channel_id", channelID, "user_id", userID)
		return
	}
	for _, vs := range states {
		if vs.UserID == userID {
			continue
		}
		h.sendSequencedToUsers(channelID, []int64{userID}, 0, buildVoiceState(vs))
	}
}
