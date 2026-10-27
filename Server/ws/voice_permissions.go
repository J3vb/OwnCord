package ws

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/permissions"
)

var errVoiceMediaPending = errors.New("voice media update pending")

// syncVoiceParticipantPermissions serializes reconciliation with moderation.
// The channel and join token identify the session that requested this work;
// a newer membership is never followed by an older permission update.
func (h *Hub) syncVoiceParticipantPermissions(ctx context.Context, userID, channelID int64, joinToken string) error {
	unlock := h.voiceMod.lock(userID)
	defer unlock()
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, joinToken)
}

func (h *Hub) trySyncVoiceParticipantPermissions(ctx context.Context, userID, channelID int64, joinToken string) error {
	unlock, acquired := h.voiceMod.tryLock(userID)
	if !acquired {
		return nil
	}
	defer unlock()
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, joinToken)
}

// ReconcileChannelVoicePermissions re-applies the publish grants of everyone
// currently in the channel. The admin AFK route calls it right after the flag
// moves, so members already in the channel lose (or regain) the microphone,
// camera and screen share now instead of at the next 60 s sweep. It is bounded
// by sweepTimeout and by the hub's lifetime; a member whose LiveKit
// participant is already gone is skipped, and a failure is left to the sweep.
func (h *Hub) ReconcileChannelVoicePermissions(channelID int64) {
	if h.livekit == nil {
		return
	}
	h.mu.RLock()
	members := make([]*Client, 0, 8)
	for _, c := range h.allClientsLocked() {
		if c.voice.channel() == channelID {
			members = append(members, c)
		}
	}
	h.mu.RUnlock()
	if len(members) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(h.life, sweepTimeout)
	defer cancel()
	for _, c := range members {
		if ctx.Err() != nil {
			return
		}
		curCh, joinToken := c.voice.state()
		if curCh != channelID || joinToken == "" {
			continue
		}
		if err := h.syncVoiceParticipantPermissions(ctx, c.userID, channelID, joinToken); err != nil && !liveKitParticipantMissing(err) {
			slog.Warn("voice permission reconciliation deferred", "user_id", c.userID, "channel_id", channelID, "err", err)
		}
	}
}

// updateVoiceParticipantPermissions requires the per-user moderation lock.
// Reads finish before the SFU call; no hub, client or database lock crosses it.
func (h *Hub) updateVoiceParticipantPermissions(ctx context.Context, userID, channelID int64, joinToken string) error {
	if h.livekit == nil {
		return fmt.Errorf("voice not configured")
	}
	state, err := h.voice.State(ctx, userID)
	if err != nil {
		return err
	}
	if state == nil || state.ChannelID != channelID || state.JoinedAt != joinToken || joinToken == "" {
		return fmt.Errorf("voice membership changed")
	}
	// Reconciliation is the uncached backstop for role/override changes.
	sub, err := subjectFor(ctx, h.readers.Dispatch, h.permChecker, nil, userID, channelID)
	if err != nil {
		return err
	}
	// The AFK channel is listen-only: reconciliation must not re-grant what
	// the join and the token refresh withheld. Fail closed on a lookup error.
	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil {
		return err
	}
	if ch != nil && ch.AFK {
		return h.livekit.updateParticipantPublishing(ctx, channelID, userID, joinToken, false, false, false)
	}
	return h.livekit.updateParticipantPublishing(ctx, channelID, userID, joinToken,
		voiceMicrophoneAllowed(sub.Has(permissions.SpeakVoice), state),
		sub.Has(permissions.UseVideo), sub.Has(permissions.ShareScreen))
}
