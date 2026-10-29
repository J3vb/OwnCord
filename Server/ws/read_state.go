package ws

import "github.com/J3vb/OwnCord/Server/service"

// readStatePayload is the read_state frame's payload: targeted at
// the caller, unsequenced, not replayed. It carries the caller's read pointer
// for one channel (or DM) after a mark_read or mark_unread was accepted, and
// replaces the client's pointer, unread_count and mention_count outright.
type readStatePayload struct {
	ChannelID         int64 `json:"channel_id"`
	LastReadMessageID int64 `json:"last_read_message_id"`
	UnreadCount       int64 `json:"unread_count"`
	MentionCount      int64 `json:"mention_count"`
}

func buildReadState(channelID int64, rs service.ReadPointer) []byte {
	return buildJSON(wsMsg{Type: MsgTypeReadState, Payload: readStatePayload{
		ChannelID:         channelID,
		LastReadMessageID: rs.LastReadMessageID,
		UnreadCount:       rs.UnreadCount,
		MentionCount:      rs.MentionCount,
	}})
}

// NotifyReadState delivers a read_state frame to userID, satisfying
// service.ReadStateNotifier. It goes through SendToUserLow, the queue
// mention_count uses, so the two frames cannot reorder, and the service holds
// mentionEmitMu across the write and this call, so a reader's last frame is
// the latest committed state. Every live connection of the user
// hears it, so a read on one device clears the badge on the others. A reader with no live connection recovers the
// pointer from the next ready; nothing is replayed.
func (h *Hub) NotifyReadState(userID, channelID int64, rs service.ReadPointer) {
	h.SendToUserLow(userID, buildReadState(channelID, rs))
}
