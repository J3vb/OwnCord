package ws

import (
	"encoding/json"
	"fmt"

	"github.com/owncord/server/db"
)

// envelope is the common wrapper for all WebSocket messages.
type envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// buildJSON marshals v into a JSON byte slice, logging on failure.
func buildJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Fallback: send a generic error rather than panicking.
		b, _ = json.Marshal(map[string]string{"type": "error", "message": "internal marshal error"})
	}
	return b
}

// buildErrorMsg produces an error envelope with the given code and message.
func buildErrorMsg(code, message string) []byte {
	return buildJSON(map[string]any{
		"type": "error",
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildPresenceMsg constructs a presence broadcast payload.
func buildPresenceMsg(userID int64, status string) []byte {
	return buildJSON(map[string]any{
		"type": "presence",
		"payload": map[string]any{
			"user_id": userID,
			"status":  status,
		},
	})
}

// buildMemberJoin constructs a member_join broadcast for when a user comes online.
func buildMemberJoin(user *db.User) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}
	return buildJSON(map[string]any{
		"type": "member_join",
		"payload": map[string]any{
			"id":       user.ID,
			"username": user.Username,
			"avatar":   avatarVal,
			"status":   "online",
			"role_id":  user.RoleID,
		},
	})
}

// buildChatMessage constructs a chat_message broadcast envelope.
func buildChatMessage(msgID, channelID, userID int64, username string, avatar *string, content string, timestamp string, replyTo *int64) []byte {
	var avatarVal any
	if avatar != nil {
		avatarVal = *avatar
	}
	return buildJSON(map[string]any{
		"type": "chat_message",
		"payload": map[string]any{
			"id":         msgID,
			"channel_id": channelID,
			"user": map[string]any{
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
	return buildJSON(map[string]any{
		"type": "chat_send_ok",
		"id":   requestID,
		"payload": map[string]any{
			"message_id": msgID,
			"timestamp":  timestamp,
		},
	})
}

// buildChatEdited constructs a chat_edited broadcast.
func buildChatEdited(msgID, channelID int64, content, editedAt string) []byte {
	return buildJSON(map[string]any{
		"type": "chat_edited",
		"payload": map[string]any{
			"message_id": msgID,
			"channel_id": channelID,
			"content":    content,
			"edited_at":  editedAt,
		},
	})
}

// buildChatDeleted constructs a chat_deleted broadcast.
func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(map[string]any{
		"type": "chat_deleted",
		"payload": map[string]any{
			"message_id": msgID,
			"channel_id": channelID,
		},
	})
}

// buildReactionUpdate constructs a reaction_update broadcast.
func buildReactionUpdate(msgID, channelID, userID int64, emoji, action string) []byte {
	return buildJSON(map[string]any{
		"type": "reaction_update",
		"payload": map[string]any{
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
	return buildJSON(map[string]any{
		"type": "typing",
		"payload": map[string]any{
			"channel_id": channelID,
			"user_id":    userID,
			"username":   username,
		},
	})
}

// buildVoiceState constructs a voice_state server->client broadcast.
func buildVoiceState(state db.VoiceState) []byte {
	return buildJSON(map[string]any{
		"type": "voice_state",
		"payload": map[string]any{
			"channel_id": state.ChannelID,
			"user_id":    state.UserID,
			"username":   state.Username,
			"muted":      state.Muted,
			"deafened":   state.Deafened,
			"speaking":   state.Speaking,
		},
	})
}

// buildVoiceLeave constructs a voice_leave server->client broadcast.
func buildVoiceLeave(channelID, userID int64) []byte {
	return buildJSON(map[string]any{
		"type": "voice_leave",
		"payload": map[string]any{
			"channel_id": channelID,
			"user_id":    userID,
		},
	})
}

// buildVoiceSignalRelay relays a signaling message (offer/answer/ice) as-is to
// channel members. The original payload is embedded unchanged.
// channelID is provided for future filtering logic.
func buildVoiceSignalRelay(msgType string, _ int64, data json.RawMessage) []byte {
	return buildJSON(map[string]any{
		"type":    msgType,
		"payload": data,
	})
}

// buildSoundboardPlay constructs a soundboard_play broadcast.
func buildSoundboardPlay(soundID string, userID int64) []byte {
	return buildJSON(map[string]any{
		"type": "soundboard_play",
		"payload": map[string]any{
			"sound_id": soundID,
			"user_id":  userID,
		},
	})
}

// buildChannelCreate constructs a channel_create broadcast.
func buildChannelCreate(ch *db.Channel) []byte {
	return buildJSON(map[string]any{
		"type": "channel_create",
		"payload": map[string]any{
			"id":       ch.ID,
			"name":     ch.Name,
			"type":     ch.Type,
			"category": ch.Category,
			"topic":    ch.Topic,
			"position": ch.Position,
		},
	})
}

// buildChannelUpdate constructs a channel_update broadcast.
func buildChannelUpdate(ch *db.Channel) []byte {
	return buildJSON(map[string]any{
		"type": "channel_update",
		"payload": map[string]any{
			"id":       ch.ID,
			"name":     ch.Name,
			"type":     ch.Type,
			"category": ch.Category,
			"topic":    ch.Topic,
			"position": ch.Position,
		},
	})
}

// buildChannelDelete constructs a channel_delete broadcast.
func buildChannelDelete(channelID int64) []byte {
	return buildJSON(map[string]any{
		"type": "channel_delete",
		"payload": map[string]any{
			"id": channelID,
		},
	})
}

// buildServerRestartMsg constructs a server_restart broadcast.
func buildServerRestartMsg(reason string, delaySeconds int) []byte {
	return buildJSON(map[string]any{
		"type": "server_restart",
		"payload": map[string]any{
			"reason":        reason,
			"delay_seconds": delaySeconds,
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
