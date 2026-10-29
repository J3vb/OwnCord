package ws

import (
	"context"
	"log/slog"
)

// SendDMVoiceRoster tells userID who is in channelID's call right now, as one
// sequenced voice_state frame per participant. A user added to a group DM while
// its call is live is outside the voice fan-out (which reaches only the
// participants and the readers at the time), so without this they never see the
// roster until a full ready: no in-call glyph, no Join strip.
//
// The REST handler calls it after the refreshed dm_channel_open for the added
// user, from the same goroutine, so on their connection the open (high queue)
// arrives before the first state. The frames are sequenced so a reconnect
// replay covers them. The read runs before any hub lock is taken; a failed read
// logs and sends nothing, and the add that triggered it stays committed.
//
// A leave that takes its seq between the read and these sends leaves a stale
// state behind it in the replay ring until the next full ready; the client
// drops any earlier roster when it first learns of the group, so the window
// is the microseconds between the two.
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
		h.sendSequencedToUsers(channelID, []int64{userID}, buildVoiceState(vs))
	}
}
