package service

import (
	"context"
	"log/slog"
)

// fillGroupOwner sets result.DMOwnerID for a group DM that this send (re)opened
// for someone, because only a (re)open builds a dm_channel_open and so needs the
// owner. A read failure is non-fatal: the open goes out without owner_id and the
// next ready repairs it.
func (s *MessageService) fillGroupOwner(ctx context.Context, isGroup bool, channelID int64, result *SendMessageResult) {
	if !isGroup || len(result.OpenedDMFor) == 0 {
		return
	}
	ownerID, err := s.st.GetGroupDMOwner(ctx, channelID)
	if err != nil {
		slog.Warn("MessageService.SendMessage GetGroupDMOwner failed, the open carries no owner_id", "err", err, "channel_id", channelID)
		return
	}
	result.DMOwnerID = ownerID
}
