package ws

// mentionCountPayload is the mention_count frame's payload (DP-27): targeted
// at one reader, unsequenced, not replayed. channel_id names the channel whose
// read_states.mention_count changed; count is the reader's total after the
// bump. A client uses it to repaint that channel's badge live when the channel
// is not focused, whose chat_message broadcasts it never receives.
type mentionCountPayload struct {
	ChannelID int64 `json:"channel_id"`
	Count     int64 `json:"count"`
}

func buildMentionCount(channelID, count int64) []byte {
	return buildJSON(wsMsg{Type: MsgTypeMentionCount, Payload: mentionCountPayload{
		ChannelID: channelID, Count: count,
	}})
}

// NotifyMentionCount delivers a live mention_count frame to userID, satisfying
// service.MentionCountNotifier. Targeted and unsequenced (SendToUserLow): a
// disconnected reader recovers the authoritative count on their next ready,
// so a missed frame costs nothing — exactly the posture of
// NotifyAppealStatus/NotifyModAction. The count is the sender-side total, not
// a delta, so a lost or duplicated frame still converges.
func (h *Hub) NotifyMentionCount(userID, channelID, count int64) {
	h.SendToUserLow(userID, buildMentionCount(channelID, count))
}
