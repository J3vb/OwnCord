package ws

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/service"
)

// The channel-level private flag: a guild channel is private when the default
// role cannot READ_MESSAGES there once its override applies. The service owns the
// reads (service.ChannelPrivacyService); the verdict is the same for every
// recipient.
// The lock is cosmetic: no ChannelPrivacy, no default role or a failed read reads
// as not private, with a debug log, and never fails a frame.

func (h *Hub) privacySnapshot(ctx context.Context) service.ChannelPrivacySnapshot {
	if h.seams.privacy == nil {
		return service.ChannelPrivacySnapshot{}
	}
	snap, err := h.seams.privacy.Snapshot(ctx)
	if err != nil {
		slog.Debug("hub: channel privacy snapshot unavailable, sending private=false", "err", err)
		return service.ChannelPrivacySnapshot{}
	}
	return snap
}

// channelIsPrivate is the private flag for one guild channel frame; a DM is never
// private. A read racing an override edit sees old or new; the refresh frame that
// edit triggers corrects it.
func (h *Hub) channelIsPrivate(ctx context.Context, channelID int64, chanType string) bool {
	if h.seams.privacy == nil || chanType == "dm" {
		return false
	}
	private, err := h.seams.privacy.ChannelIsPrivate(ctx, channelID)
	if err != nil {
		slog.Debug("hub: channelIsPrivate read failed, sending private=false", "channel_id", channelID, "err", err)
		return false
	}
	return private
}
