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

// buildRateLimitError produces a RATE_LIMITED error with retry_after per PROTOCOL.md.
func buildRateLimitError(message string, retryAfterSeconds float64) []byte {
	return buildJSON(map[string]any{
		"type": "error",
		"payload": map[string]any{
			"code":        "RATE_LIMITED",
			"message":     message,
			"retry_after": retryAfterSeconds,
		},
	})
}

// buildAuthError produces an auth_error envelope per PROTOCOL.md.
// The client treats this type as non-recoverable and stops reconnecting.
func buildAuthError(message string) []byte {
	return buildJSON(map[string]any{
		"type": "auth_error",
		"payload": map[string]string{
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
func buildMemberJoin(user *db.User, roleName string) []byte {
	var avatarVal any
	if user.Avatar != nil {
		avatarVal = *user.Avatar
	}
	return buildJSON(map[string]any{
		"type": "member_join",
		"payload": map[string]any{
			"user": map[string]any{
				"id":       user.ID,
				"username": user.Username,
				"avatar":   avatarVal,
				"role":     roleName,
			},
		},
	})
}

// buildChatMessage constructs a chat_message broadcast envelope.
// Includes role in user object and empty reactions array for consistency with REST API.
func buildChatMessage(msgID, channelID, userID int64, username string, avatar *string, roleName string, content string, timestamp string, replyTo *int64, attachments []map[string]any) []byte {
	var avatarVal any
	if avatar != nil {
		avatarVal = *avatar
	}
	if attachments == nil {
		attachments = []map[string]any{}
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
				"role":     roleName,
			},
			"content":     content,
			"reply_to":    replyTo,
			"timestamp":   timestamp,
			"attachments": attachments,
			"reactions":   []any{},
		},
	})
}

// buildMemberUpdate constructs a member_update broadcast per PROTOCOL.md.
func buildMemberUpdate(userID int64, roleName string) []byte {
	return buildJSON(map[string]any{
		"type": "member_update",
		"payload": map[string]any{
			"user_id": userID,
			"role":    roleName,
		},
	})
}

// buildMemberBan constructs a member_ban broadcast per PROTOCOL.md.
func buildMemberBan(userID int64) []byte {
	return buildJSON(map[string]any{
		"type": "member_ban",
		"payload": map[string]any{
			"user_id": userID,
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
			"channel_id":  state.ChannelID,
			"user_id":     state.UserID,
			"username":    state.Username,
			"muted":       state.Muted,
			"deafened":    state.Deafened,
			"speaking":    state.Speaking,
			"camera":      state.Camera,
			"screenshare": state.Screenshare,
		},
	})
}

// buildVoiceConfig constructs a voice_config message sent after voice_join acceptance.
func buildVoiceConfig(channelID int64, quality string, bitrate int, maxUsers int) []byte {
	return buildJSON(map[string]any{
		"type": "voice_config",
		"payload": map[string]any{
			"channel_id": channelID,
			"quality":    quality,
			"bitrate":    bitrate,
			"max_users":  maxUsers,
		},
	})
}

// buildVoiceToken constructs a voice_token message with a LiveKit token and URL.
// url is the proxy path ("/livekit") for remote clients; direct_url is the raw
// LiveKit URL (e.g. "ws://localhost:7880") for localhost clients.
func buildVoiceToken(channelID int64, token string, proxyPath string, directURL string) []byte {
	return buildJSON(map[string]any{
		"type": "voice_token",
		"payload": map[string]any{
			"channel_id": channelID,
			"token":      token,
			"url":        proxyPath,
			"direct_url": directURL,
		},
	})
}

// buildVoiceSpeakers constructs a voice_speakers broadcast.
func buildVoiceSpeakers(channelID int64, speakers []int64, mode string) []byte {
	return buildJSON(map[string]any{
		"type": "voice_speakers",
		"payload": map[string]any{
			"channel_id":     channelID,
			"speakers":       speakers,
			"threshold_mode": mode,
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
