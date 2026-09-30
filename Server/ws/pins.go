package ws

// chatPinnedPayload is the pin/unpin broadcast (F5). It carries the state so
// a client can set the row's pin flag and the panel can refresh.
type chatPinnedPayload struct {
	MessageID int64 `json:"message_id"`
	ChannelID int64 `json:"channel_id"`
	Pinned    bool  `json:"pinned"`
}

// BroadcastMessagePinned tells every reader of channelID that a message was
// pinned or unpinned, so other clients and the pinning user's own other
// devices do not show stale pins (F5). Sequenced like chat_edited, so it
// replays on reconnect.
func (h *Hub) BroadcastMessagePinned(channelID, messageID int64, pinned bool) {
	h.BroadcastToChannel(channelID, buildChatPinned(messageID, channelID, pinned))
}

// buildChatPinned constructs a chat_pinned broadcast.
func buildChatPinned(messageID, channelID int64, pinned bool) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeChatPinned,
		Payload: chatPinnedPayload{
			MessageID: messageID,
			ChannelID: channelID,
			Pinned:    pinned,
		},
	})
}
