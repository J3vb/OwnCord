package service

import (
	"context"
	"log/slog"
)

// fillGroupOwner sets result.DMOwnerID and result.DMIconID for a group DM that
// this send (re)opened for someone, because only a (re)open builds a
// dm_channel_open and so needs them. A read failure is non-fatal: the open goes
// out without owner_id and icon, and the next ready repairs it.
func (s *dmDelivery) fillGroupOwner(ctx context.Context, isGroup bool, channelID int64, result *SendMessageResult) {
	if !isGroup || len(result.OpenedDMFor) == 0 {
		return
	}
	ownerID, iconID, err := s.st.GetGroupDMMeta(ctx, channelID)
	if err != nil {
		slog.Warn("MessageService.SendMessage GetGroupDMMeta failed, the open carries no owner_id or icon", "err", err, "channel_id", channelID)
		return
	}
	result.DMOwnerID = ownerID
	result.DMIconID = iconID
}
