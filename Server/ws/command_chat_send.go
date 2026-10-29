package ws

import (
	"encoding/json"
	"fmt"
)

// parseChatSend is the chat_send entry of commandConstructors. sticker_id, when
// present, must be a positive integer; whether the rest of the send
// is consistent with a sticker is the service's call.
func parseChatSend(userID int64, reqID string, raw json.RawMessage) (Command, error) {
	var p struct {
		ClientMessageID string      `json:"client_message_id"`
		ChannelID       json.Number `json:"channel_id"`
		Content         string      `json:"content"`
		ReplyTo         *int64      `json:"reply_to"`
		ReplyPing       *bool       `json:"reply_ping"`
		Attachments     []string    `json:"attachments"`
		StickerID       *int64      `json:"sticker_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid chat_send payload: %w", err)
	}
	var stickerID int64
	if p.StickerID != nil {
		if *p.StickerID <= 0 {
			return nil, fmt.Errorf("sticker_id must be a positive integer")
		}
		stickerID = *p.StickerID
	}
	chID, err := positiveID(p.ChannelID, "channel_id")
	if err != nil {
		return nil, err
	}
	if len(p.Attachments) > 10 {
		return nil, fmt.Errorf("too many attachments (max 10)")
	}
	// These are upload IDs (UUIDs from POST /api/v1/uploads), NOT URLs: the
	// client renders an attachment by resolving its id to /api/v1/files/{id},
	// and SendMessage links each id through LinkAttachmentsToMessage, which
	// keeps only ids that name a real upload owned by the sender and still
	// unlinked. A javascript:/data: string is therefore never stored or
	// echoed — it simply matches no row and is dropped. A scheme check would
	// be wrong here (it would reject the legitimate UUID ids); the only
	// bound that applies is length.
	for i, id := range p.Attachments {
		if len(id) > 2048 {
			return nil, fmt.Errorf("attachment[%d] id too long (max 2048)", i)
		}
	}
	attachments := make([]string, len(p.Attachments))
	copy(attachments, p.Attachments)
	return ChatSendCmd{
		ClientMessageID: p.ClientMessageID,
		userID:          userID,
		ReqID:           reqID,
		ChannelID:       chID,
		Content:         p.Content,
		ReplyTo:         p.ReplyTo,
		ReplyPing:       p.ReplyTo != nil && p.ReplyPing != nil && *p.ReplyPing,
		attachments:     attachments,
		StickerID:       stickerID,
	}, nil
}
