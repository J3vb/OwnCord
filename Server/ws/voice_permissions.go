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
	unlock := h.voiceHub.mod.Lock(userID)
	defer unlock()
	return h.updateVoiceParticipantPermissions(ctx, userID, channelID, joinToken)
}

func (h *Hub) trySyncVoiceParticipantPermissions(ctx context.Context, userID, channelID int64, joinToken string) error {
	unlock, acquired := h.voiceHub.mod.TryLock(userID)
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
	ctx, cancel := context.WithTimeout(h.lifecycle.ctx, sweepTimeout)
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

type voicePublishGrants struct {
	microphone, camera, screenshare bool
}

// currentVoiceGrants is the one rule for what a join may publish right now, for a live participant
// and for a session about to start. live is false when the row is gone or names another join.
// Reconciliation is the uncached backstop for role/override changes, so the permission read skips
// the cache.
func (h *Hub) currentVoiceGrants(ctx context.Context, userID, channelID int64, joinToken string) (voicePublishGrants, bool, error) {
	grants, live, _, err := h.voiceGrantsAndStay(ctx, userID, channelID, joinToken)
	return grants, live, err
}

// sessionVoiceGrants is currentVoiceGrants for a session about to start: live is also false
// when permissions.CanStayInVoice refuses. Moderation and reconcile keep currentVoiceGrants,
// so they still reach a member the sweep has yet to remove.
func (h *Hub) sessionVoiceGrants(ctx context.Context, userID, channelID int64, joinToken string) (voicePublishGrants, bool, error) {
	grants, live, mayStay, err := h.voiceGrantsAndStay(ctx, userID, channelID, joinToken)
	return grants, live && mayStay, err
}

// voiceGrantsAndStay reads the join, the channel and its live subject once. A missing
// channel is not live.
func (h *Hub) voiceGrantsAndStay(ctx context.Context, userID, channelID int64, joinToken string) (grants voicePublishGrants, live, mayStay bool, err error) {
	state, err := h.voice.State(ctx, userID)
	if err != nil {
		return voicePublishGrants{}, false, false, fmt.Errorf("reading voice state: %w", err)
	}
	if state == nil || state.ChannelID != channelID || state.JoinedAt != joinToken || joinToken == "" {
		return voicePublishGrants{}, false, false, nil
	}
	ch, err := h.readers.Dispatch.GetChannel(ctx, channelID)
	if err != nil {
		return voicePublishGrants{}, false, false, fmt.Errorf("reading voice channel: %w", err)
	}
	if ch == nil {
		return voicePublishGrants{}, false, false, nil
	}
	sub, err := channelSubject(ctx, h.readers.Dispatch, h.permChecker, nil, userID, ch, true)
	if err != nil {
		return voicePublishGrants{}, false, false, fmt.Errorf("resolving voice permissions: %w", err)
	}
	mayStay = permissions.CanStayInVoice(sub) == nil
	// The AFK channel is listen-only: reconciliation must not re-grant what
	// the join and the token refresh withheld.
	if ch.AFK {
		return voicePublishGrants{}, true, mayStay, nil
	}
	return voicePublishGrants{
		microphone:  voiceMicrophoneAllowed(sub.Has(permissions.SpeakVoice), state),
		camera:      sub.Has(permissions.UseVideo),
		screenshare: sub.Has(permissions.ShareScreen),
	}, true, mayStay, nil
}

// updateVoiceParticipantPermissions requires the per-user moderation lock.
// Reads finish before the SFU call; no hub, client or database lock crosses it.
func (h *Hub) updateVoiceParticipantPermissions(ctx context.Context, userID, channelID int64, joinToken string) error {
	if h.livekit == nil {
		return fmt.Errorf("voice not configured")
	}
	grants, live, err := h.currentVoiceGrants(ctx, userID, channelID, joinToken)
	if err != nil {
		return err
	}
	if !live {
		return fmt.Errorf("voice membership changed")
	}
	return h.livekit.updateParticipantPublishing(ctx, channelID, userID, joinToken,
		grants.microphone, grants.camera, grants.screenshare)
}
