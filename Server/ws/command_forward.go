package ws

import (
	"encoding/json"
	"fmt"
)

// ChatForwardCmd copies MessageID into ChannelID, one target per frame so each
// forward commits whole or not at all.
type ChatForwardCmd struct {
	userID          int64
	ReqID           string
	ClientMessageID string
	ChannelID       int64
	MessageID       int64
}

func (c ChatForwardCmd) Type() string  { return MsgTypeChatForward }
func (c ChatForwardCmd) UserID() int64 { return c.userID }

// parseChatForward is the chat_forward entry of commandConstructors;
// client_message_id is required since a forward is retried only by receipt.
func parseChatForward(userID int64, reqID string, raw json.RawMessage) (Command, error) {
	var p struct {
		ClientMessageID string      `json:"client_message_id"`
		ChannelID       json.Number `json:"channel_id"`
		MessageID       json.Number `json:"message_id"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("invalid chat_forward payload: %w", err)
	}
	chID, err := positiveID(p.ChannelID, "channel_id")
	if err != nil {
		return nil, err
	}
	msgID, err := positiveID(p.MessageID, "message_id")
	if err != nil {
		return nil, err
	}
	if p.ClientMessageID == "" {
		return nil, fmt.Errorf("client_message_id is required")
	}
	return ChatForwardCmd{
		userID: userID, ReqID: reqID, ClientMessageID: p.ClientMessageID, ChannelID: chID, MessageID: msgID,
	}, nil
}

type chatForwardOKPayload struct {
	MessageID       int64  `json:"message_id"`
	ChannelID       int64  `json:"channel_id"`
	ClientMessageID string `json:"client_message_id"`
	Deduplicated    bool   `json:"deduplicated"`
}

func buildChatForwardOK(requestID string, msgID, channelID int64, clientMessageID string, duplicate bool) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeChatForwardOK,
		ID:   requestID,
		Payload: chatForwardOKPayload{
			MessageID: msgID, ChannelID: channelID, ClientMessageID: clientMessageID, Deduplicated: duplicate,
		},
	})
}
