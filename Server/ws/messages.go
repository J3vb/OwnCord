package ws

import (
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/owncord/server/db"
)

// envelope is the common wrapper for all WebSocket messages.
type envelope struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// wsMsg is the generic envelope for outbound WebSocket messages.
type wsMsg struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

// ---------------------------------------------------------------------------
// Payload structs — one per outbound message type.
// ---------------------------------------------------------------------------

type presencePayload struct {
	UserID int64  `json:"user_id"`
	Status string `json:"status"`
}

type memberUserPayload struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar"`
	Role     string  `json:"role"`
}

type memberJoinPayload struct {
	User memberUserPayload `json:"user"`
}

type chatMessagePayload struct {
	ID          int64              `json:"id"`
	ChannelID   int64              `json:"channel_id"`
	User        memberUserPayload  `json:"user"`
	Content     string             `json:"content"`
	ReplyTo     *int64             `json:"reply_to"`
	Timestamp   string             `json:"timestamp"`
	Attachments []map[string]any   `json:"attachments"`
	Reactions   []any              `json:"reactions"`
	Pinned      bool               `json:"pinned"`
}

type memberUpdatePayload struct {
	UserID int64  `json:"user_id"`
	Role   string `json:"role"`
}

type memberBanPayload struct {
	UserID int64 `json:"user_id"`
}

type chatSendOKPayload struct {
	MessageID int64  `json:"message_id"`
	Timestamp string `json:"timestamp"`
}

type chatEditedPayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Content   string `json:"content"`
	EditedAt  string `json:"edited_at"`
}

type chatDeletedPayload struct {
	MessageID int64 `json:"message_id"`
	ChannelID int64 `json:"channel_id"`
}

type reactionUpdatePayload struct {
	MessageID int64  `json:"message_id"`
	ChannelID int64  `json:"channel_id"`
	Emoji     string `json:"emoji"`
	UserID    int64  `json:"user_id"`
	Action    string `json:"action"`
}

type typingPayload struct {
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
}

type voiceStatePayload struct {
	ChannelID   int64  `json:"channel_id"`
	UserID      int64  `json:"user_id"`
	Username    string `json:"username"`
	Muted       bool   `json:"muted"`
	Deafened    bool   `json:"deafened"`
	Speaking    bool   `json:"speaking"`
	Camera      bool   `json:"camera"`
	Screenshare bool   `json:"screenshare"`
}

type voiceConfigPayload struct {
	ChannelID       int64  `json:"channel_id"`
	Quality         string `json:"quality"`
	Bitrate         int    `json:"bitrate"`
	MaxUsers        int    `json:"max_users"`
	ThresholdMode   string `json:"threshold_mode"`
	MixingThreshold int    `json:"mixing_threshold"`
	TopSpeakers     int    `json:"top_speakers"`
}

type voiceTokenPayload struct {
	ChannelID int64  `json:"channel_id"`
	Token     string `json:"token"`
	URL       string `json:"url"`
	DirectURL string `json:"direct_url"`
}

type voiceLeavePayload struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int64 `json:"user_id"`
}

type channelPayload struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	Topic    string `json:"topic"`
	Position int    `json:"position"`
}

type channelDeletePayload struct {
	ID int64 `json:"id"`
}

type serverRestartPayload struct {
	Reason       string `json:"reason"`
	DelaySeconds int    `json:"delay_seconds"`
}

// dmChannelOpenPayload is sent when a DM is opened/reopened for a user.
type dmChannelOpenPayload struct {
	ChannelID int64     `json:"channel_id"`
	Recipient dmUserPayload `json:"recipient"`
}

// dmUserPayload is the public-facing shape for a DM participant in WS events.
type dmUserPayload struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
	Status   string `json:"status"`
}

// ---------------------------------------------------------------------------
// Builder helpers (kept as maps per task spec).
// ---------------------------------------------------------------------------

// buildJSON marshals v into a JSON byte slice, logging on failure.
func buildJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		slog.Error("buildJSON marshal failed", "error", err, "type", fmt.Sprintf("%T", v))
		// Fallback: send a generic error rather than panicking.
		b, _ = json.Marshal(map[string]string{"type": "error", "message": "internal marshal error"})
	}
	return b
}

// buildErrorMsg produces an error envelope with the given code and message.
func buildErrorMsg(code, message string) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeError,
		"payload": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// buildRateLimitError produces a RATE_LIMITED error with retry_after per PROTOCOL.md.
func buildRateLimitError(message string, retryAfterSeconds float64) []byte {
	return buildJSON(map[string]any{
		"type": MsgTypeError,
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
		"type": MsgTypeAuthError,
		"payload": map[string]string{
			"message": message,
		},
	})
}

// ---------------------------------------------------------------------------
// Typed message builders.
// ---------------------------------------------------------------------------

// buildPresenceMsg constructs a presence broadcast payload.
func buildPresenceMsg(userID int64, status string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypePresence,
		Payload: presencePayload{UserID: userID, Status: status},
	})
}

// buildMemberJoin constructs a member_join broadcast for when a user comes online.
func buildMemberJoin(user *db.User, roleName string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeMemberJoin,
		Payload: memberJoinPayload{
			User: memberUserPayload{
				ID:       user.ID,
				Username: user.Username,
				Avatar:   user.Avatar,
				Role:     roleName,
			},
		},
	})
}

// buildChatMessage constructs a chat_message broadcast envelope.
// Includes role in user object and empty reactions array for consistency with REST API.
func buildChatMessage(msgID, channelID, userID int64, username string, avatar *string, roleName string, content string, timestamp string, replyTo *int64, attachments []map[string]any) []byte {
	if attachments == nil {
		attachments = []map[string]any{}
	}
	return buildJSON(wsMsg{
		Type: MsgTypeChatMessage,
		Payload: chatMessagePayload{
			ID:        msgID,
			ChannelID: channelID,
			User: memberUserPayload{
				ID:       userID,
				Username: username,
				Avatar:   avatar,
				Role:     roleName,
			},
			Content:     content,
			ReplyTo:     replyTo,
			Timestamp:   timestamp,
			Attachments: attachments,
			Reactions:   []any{},
			Pinned:      false,
		},
	})
}

// buildMemberUpdate constructs a member_update broadcast per PROTOCOL.md.
func buildMemberUpdate(userID int64, roleName string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberUpdate,
		Payload: memberUpdatePayload{UserID: userID, Role: roleName},
	})
}

// buildMemberBan constructs a member_ban broadcast per PROTOCOL.md.
func buildMemberBan(userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeMemberBan,
		Payload: memberBanPayload{UserID: userID},
	})
}

// buildChatSendOK constructs a chat_send_ok ack.
func buildChatSendOK(requestID string, msgID int64, timestamp string) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatSendOK,
		ID:      requestID,
		Payload: chatSendOKPayload{MessageID: msgID, Timestamp: timestamp},
	})
}

// buildChatEdited constructs a chat_edited broadcast.
func buildChatEdited(msgID, channelID int64, content, editedAt string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeChatEdited,
		Payload: chatEditedPayload{
			MessageID: msgID,
			ChannelID: channelID,
			Content:   content,
			EditedAt:  editedAt,
		},
	})
}

// buildChatDeleted constructs a chat_deleted broadcast.
func buildChatDeleted(msgID, channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChatDeleted,
		Payload: chatDeletedPayload{MessageID: msgID, ChannelID: channelID},
	})
}

// buildReactionUpdate constructs a reaction_update broadcast.
func buildReactionUpdate(msgID, channelID, userID int64, emoji, action string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeReactionUpdate,
		Payload: reactionUpdatePayload{
			MessageID: msgID,
			ChannelID: channelID,
			Emoji:     emoji,
			UserID:    userID,
			Action:    action,
		},
	})
}

// buildTypingMsg constructs a typing broadcast.
func buildTypingMsg(channelID, userID int64, username string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeTyping,
		Payload: typingPayload{
			ChannelID: channelID,
			UserID:    userID,
			Username:  username,
		},
	})
}

// buildVoiceState constructs a voice_state server->client broadcast.
func buildVoiceState(state db.VoiceState) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceState,
		Payload: voiceStatePayload{
			ChannelID:   state.ChannelID,
			UserID:      state.UserID,
			Username:    state.Username,
			Muted:       state.Muted,
			Deafened:    state.Deafened,
			Speaking:    state.Speaking,
			Camera:      state.Camera,
			Screenshare: state.Screenshare,
		},
	})
}

// buildVoiceConfig constructs a voice_config message sent after voice_join acceptance.
func buildVoiceConfig(channelID int64, quality string, bitrate int, maxUsers int) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceConfig,
		Payload: voiceConfigPayload{
			ChannelID:       channelID,
			Quality:         quality,
			Bitrate:         bitrate,
			MaxUsers:        maxUsers,
			ThresholdMode:   "top_speakers",
			MixingThreshold: 0,
			TopSpeakers:     5,
		},
	})
}

// buildVoiceToken constructs a voice_token message with a LiveKit token and URL.
// url is the proxy path ("/livekit") for remote clients; direct_url is the raw
// LiveKit URL (e.g. "ws://localhost:7880") for localhost clients.
func buildVoiceToken(channelID int64, token string, proxyPath string, directURL string) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeVoiceToken,
		Payload: voiceTokenPayload{
			ChannelID: channelID,
			Token:     token,
			URL:       proxyPath,
			DirectURL: directURL,
		},
	})
}

// buildVoiceLeave constructs a voice_leave server->client broadcast.
func buildVoiceLeave(channelID, userID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeVoiceLeaveBC,
		Payload: voiceLeavePayload{ChannelID: channelID, UserID: userID},
	})
}

// buildChannelCreate constructs a channel_create broadcast.
func buildChannelCreate(ch *db.Channel) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeChannelCreate,
		Payload: channelPayload{
			ID:       ch.ID,
			Name:     ch.Name,
			Type:     ch.Type,
			Category: ch.Category,
			Topic:    ch.Topic,
			Position: ch.Position,
		},
	})
}

// buildChannelUpdate constructs a channel_update broadcast.
func buildChannelUpdate(ch *db.Channel) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeChannelUpdate,
		Payload: channelPayload{
			ID:       ch.ID,
			Name:     ch.Name,
			Type:     ch.Type,
			Category: ch.Category,
			Topic:    ch.Topic,
			Position: ch.Position,
		},
	})
}

// buildChannelDelete constructs a channel_delete broadcast.
func buildChannelDelete(channelID int64) []byte {
	return buildJSON(wsMsg{
		Type:    MsgTypeChannelDelete,
		Payload: channelDeletePayload{ID: channelID},
	})
}

// buildDMChannelOpen constructs a dm_channel_open event sent to a user.
// Returns nil if recipient is nil to avoid a panic on dereferencing.
func buildDMChannelOpen(channelID int64, recipient *db.User) []byte {
	if recipient == nil {
		slog.Warn("buildDMChannelOpen called with nil recipient", "channel_id", channelID)
		return nil
	}
	avatarStr := ""
	if recipient.Avatar != nil {
		avatarStr = *recipient.Avatar
	}
	return buildJSON(wsMsg{
		Type: MsgTypeDMChannelOpen,
		Payload: dmChannelOpenPayload{
			ChannelID: channelID,
			Recipient: dmUserPayload{
				ID:       recipient.ID,
				Username: recipient.Username,
				Avatar:   avatarStr,
				Status:   recipient.Status,
			},
		},
	})
}

// buildServerRestartMsg constructs a server_restart broadcast.
func buildServerRestartMsg(reason string, delaySeconds int) []byte {
	return buildJSON(wsMsg{
		Type: MsgTypeServerRestart,
		Payload: serverRestartPayload{
			Reason:       reason,
			DelaySeconds: delaySeconds,
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
