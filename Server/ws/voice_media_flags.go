package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// clearRevokedVoiceMedia turns off voice_states.camera / screenshare for c's session in
// channelID once the user no longer holds USE_VIDEO / SHARE_SCREEN there, and broadcasts
// the corrected voice_state once. Only the enable direction is gated on the permission, so
// a flag set before a revocation would stay at 1 until the user leaves (camera keeps a
// voice_max_video slot, rosters show a stream the SFU no longer carries); the SFU grant is
// withdrawn by the reconciliation that follows. It runs under the voice lock and only
// touches the session it was handed, so a leave or rejoin since the snapshot is left alone.
func (h *Hub) clearRevokedVoiceMedia(ctx context.Context, c *Client, channelID int64) {
	txn := h.begin(c.userID)
	defer txn.end()

	curChID, joinToken := c.voice.state()
	if curChID != channelID || joinToken == "" {
		return
	}
	state, err := h.voice.State(ctx, c.userID)
	if err != nil {
		slog.Warn("voice permission reconciliation deferred", "step", "read voice state", "user_id", c.userID, "err", err)
		return
	}
	if state == nil || state.ChannelID != channelID || state.JoinedAt != joinToken {
		return
	}
	if !state.Camera && !state.Screenshare {
		return
	}
	sub, err := subjectFor(ctx, h.readers.Dispatch, h.permChecker, nil, c.userID, channelID)
	if err != nil {
		slog.Warn("voice permission reconciliation deferred", "step", "read permissions", "user_id", c.userID, "err", err)
		return
	}

	if !h.clearMediaFlags(ctx, c.userID, state.Camera, state.Screenshare, sub) {
		return
	}
	// Broadcast the row as it is now: the self-toggle handlers do not take the voice lock, so a mute or
	// deafen may have landed since the first read.
	fresh, err := h.voice.State(ctx, c.userID)
	if err != nil || fresh == nil || fresh.ChannelID != channelID || fresh.JoinedAt != joinToken {
		return
	}
	slog.Info("voice media flags cleared after a permission change",
		"user_id", c.userID, "channel_id", channelID,
		"camera", fresh.Camera, "screenshare", fresh.Screenshare)
	h.broadcastVoiceEvent(ctx, channelID, c.userID, buildVoiceState(*fresh))
}

// clearMediaFlags writes camera / screenshare to 0 where set and sub no longer holds its permission; reports
// whether anything changed.
func (h *Hub) clearMediaFlags(ctx context.Context, userID int64, camera, screenshare bool, sub permissions.Subject) (changed bool) {
	if camera && !sub.Has(permissions.UseVideo) {
		if err := h.voice.SetCamera(ctx, userID, false); err != nil {
			slog.Warn("voice permission reconciliation deferred", "step", "clear camera flag", "user_id", userID, "err", err)
		} else {
			changed = true
		}
	}
	if screenshare && !sub.Has(permissions.ShareScreen) {
		if err := h.voice.SetScreenshare(ctx, userID, false); err != nil {
			slog.Warn("voice permission reconciliation deferred", "step", "clear screenshare flag", "user_id", userID, "err", err)
		} else {
			changed = true
		}
	}
	return changed
}
