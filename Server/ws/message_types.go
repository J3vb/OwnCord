package ws

// WebSocket protocol message type constants.
// Generated from docs/protocol-schema.json — single source of truth for
// both Server (Go) and Client (TypeScript).
//
// Client → Server message types (received by handlers).
const (
	MsgTypeAuth              = "auth"
	MsgTypeChatSend          = "chat_send"
	MsgTypeChatEdit          = "chat_edit"
	MsgTypeChatDelete        = "chat_delete"
	MsgTypeReactionAdd       = "reaction_add"
	MsgTypeReactionRemove    = "reaction_remove"
	MsgTypeTypingStart       = "typing_start"
	MsgTypeChannelFocus      = "channel_focus"
	MsgTypePresenceUpdate    = "presence_update"
	MsgTypeVoiceJoin         = "voice_join"
	MsgTypeVoiceLeave        = "voice_leave"
	MsgTypeVoiceMute         = "voice_mute"
	MsgTypeVoiceDeafen       = "voice_deafen"
	MsgTypeVoiceCamera       = "voice_camera"
	MsgTypeVoiceScreenshare  = "voice_screenshare"
	MsgTypePing              = "ping"
	MsgTypeVoiceTokenRefresh = "voice_token_refresh" //nolint:gosec // G101: false positive — message type constant, not a credential
)

// Server → Client message types (sent in broadcasts/responses).
const (
	MsgTypeAuthOK         = "auth_ok"
	MsgTypeAuthError      = "auth_error"
	MsgTypeReady          = "ready"
	MsgTypeChatMessage    = "chat_message"
	MsgTypeChatSendOK     = "chat_send_ok"
	MsgTypeChatEdited     = "chat_edited"
	MsgTypeChatDeleted    = "chat_deleted"
	MsgTypeReactionUpdate = "reaction_update"
	MsgTypeTyping         = "typing"
	MsgTypePresence       = "presence"
	MsgTypeChannelCreate  = "channel_create"
	MsgTypeChannelUpdate  = "channel_update"
	MsgTypeChannelDelete  = "channel_delete"
	MsgTypeVoiceState     = "voice_state"
	MsgTypeVoiceConfig    = "voice_config"
	MsgTypeVoiceToken     = "voice_token"
	MsgTypeVoiceSpeakers  = "voice_speakers"
	MsgTypeVoiceLeaveBC   = "voice_leave" // broadcast (same string as client msg)
	MsgTypeMemberJoin     = "member_join"
	MsgTypeMemberLeave    = "member_leave"
	MsgTypeMemberUpdate   = "member_update"
	MsgTypeMemberBan      = "member_ban"
	MsgTypeServerRestart  = "server_restart"
	MsgTypeError          = "error"
	MsgTypePong           = "pong"
	MsgTypeDMChannelOpen  = "dm_channel_open"
	MsgTypeDMChannelClose = "dm_channel_close"
)
