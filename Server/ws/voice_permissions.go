package ws

import (
	"context"
	"errors"
	"fmt"

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
	return h.livekit.updateParticipantPublishing(ctx, channelID, userID, joinToken,
		voiceMicrophoneAllowed(sub.Has(permissions.SpeakVoice), state),
		sub.Has(permissions.UseVideo), sub.Has(permissions.ShareScreen))
}
