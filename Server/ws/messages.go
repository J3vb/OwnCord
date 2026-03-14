package ws

import (
	"encoding/json"
	"fmt"
)

// envelope is the common wrapper for all WebSocket messages.
type envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// buildJSON marshals v into a JSON byte slice, logging on failure.
func buildJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Fallback: send a generic error rather than panicking.
		b, _ = json.Marshal(map[string]string{"type": "error", "message": "internal marshal error"})
	}
	return b
}

// buildErrorMsg produces an error envelope with the given code and message.
func buildErrorMsg(code, message string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "error",
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildPresenceMsg constructs a presence broadcast payload.
func buildPresenceMsg(userID int64, status string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "presence",
		"payload": map[string]interface{}{
			"user_id": userID,
			"status":  status,
		},
	})
}

// buildChatMessage constructs a chat_message broadcast envelope.
func buildChatMessage(msgID, channelID, userID int64, username string, avatar *string, content string, timestamp string, replyTo *int64) []byte {
	avatarVal := interface{}(nil)
	if avatar != nil {
		avatarVal = *avatar
	}
	return buildJSON(map[string]interface{}{
		"type": "chat_message",
		"payload": map[string]interface{}{
			"id":         msgID,
			"channel_id": channelID,
			"user": map[string]interface{}{
				"id":       userID,
				"username": username,
				"avatar":   avatarVal,
			},
			"content":   content,
			"reply_to":  replyTo,
			"timestamp": timestamp,
		},
	})
}

// buildChatSendOK constructs a chat_send_ok ack.
func buildChatSendOK(requestID string, msgID int64, timestamp string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "chat_send_ok",
		"id":   requestID,
		"payload": map[string]interface{}{
			"message_id": msgID,
			"timestamp":  timestamp,
		},
	})
}

// buildChatEdited constructs a chat_edited broadcast.
func buildChatEdited(msgID, channelID int64, content, editedAt string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "chat_edited",
		"payload": map[string]interface{}{
			"message_id": msgID,
			"channel_id": channelID,
			"content":    content,
			"edited_at":  editedAt,
		},
	})
}

// buildChatDeleted constructs a chat_deleted broadcast.
func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(map[string]interface{}{
		"type": "chat_deleted",
		"payload": map[string]interface{}{
			"message_id": msgID,
			"channel_id": channelID,
		},
	})
}

// buildReactionUpdate constructs a reaction_update broadcast.
func buildReactionUpdate(msgID, channelID, userID int64, emoji, action string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "reaction_update",
		"payload": map[string]interface{}{
			"message_id": msgID,
			"channel_id": channelID,
			"emoji":      emoji,
			"user_id":    userID,
			"action":     action,
		},
	})
}

// buildTypingMsg constructs a typing broadcast.
func buildTypingMsg(channelID, userID int64, username string) []byte {
	return buildJSON(map[string]interface{}{
		"type": "typing",
		"payload": map[string]interface{}{
			"channel_id": channelID,
			"user_id":    userID,
			"username":   username,
		},
	})
}

// parseChannelID safely extracts channel_id from a raw payload map.
func parseChannelID(payload json.RawMessage) (int64, error) {
	var p struct {
		ChannelID json.Number `json:"channel_id"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return 0, err
	}
	id, err := p.ChannelID.Int64()
	if err != nil {
		return 0, fmt.Errorf("channel_id must be integer: %w", err)
	}
	return id, nil
}
