package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
)

// The channel-level private flag (3D-6): a guild channel is private when the
// default role cannot READ_MESSAGES there once the channel's override for the
// role is applied. The service owns the reads and the math
// (service.ChannelPrivacyService); the hub only asks. The verdict is the same
// for every recipient, so shared frames stay shared.
//
// The lock is cosmetic: no ChannelPrivacy, no default role or a failed read all
// read as not private, with a debug log, and never fail a frame.

// privacySnapshot reads the snapshot once for a ready build or a fan-out loop.
func (h *Hub) privacySnapshot(ctx context.Context) service.ChannelPrivacySnapshot {
	if h.privacy == nil {
		return service.ChannelPrivacySnapshot{}
	}
	snap, err := h.privacy.Snapshot(ctx)
	if err != nil {
		slog.Debug("hub: channel privacy snapshot unavailable, sending private=false", "err", err)
		return service.ChannelPrivacySnapshot{}
	}
	return snap
}

// channelIsPrivate is the private flag for one guild channel frame: one or two
// reads. A DM is never private. A read racing an override edit sees the old or
// the new row; the refresh frame that edit triggers corrects it.
func (h *Hub) channelIsPrivate(ctx context.Context, channelID int64, chanType string) bool {
	if h.privacy == nil || chanType == "dm" {
		return false
	}
	private, err := h.privacy.ChannelIsPrivate(ctx, channelID)
	if err != nil {
		slog.Debug("hub: channelIsPrivate read failed, sending private=false", "channel_id", channelID, "err", err)
		return false
	}
	return private
}
