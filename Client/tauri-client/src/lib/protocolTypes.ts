// Shared WebSocket protocol message type constants.
// Generated from docs/protocol-schema.json — single source of truth for
// both Server (Go) and Client (TypeScript).
//
// Usage:  import { MessageType } from "@lib/protocolTypes";
//         ws.send({ type: MessageType.CHAT_SEND, payload: { ... } });

// ---------------------------------------------------------------------------
// Server → Client message types
// ---------------------------------------------------------------------------

export const ServerMessageType = {
  AUTH_OK: "auth_ok",
  AUTH_ERROR: "auth_error",
  READY: "ready",
  CHAT_MESSAGE: "chat_message",
  CHAT_SEND_OK: "chat_send_ok",
  CHAT_EDITED: "chat_edited",
  CHAT_DELETED: "chat_deleted",
  REACTION_UPDATE: "reaction_update",
  TYPING: "typing",
  PRESENCE: "presence",
  CHANNEL_CREATE: "channel_create",
  CHANNEL_UPDATE: "channel_update",
  CHANNEL_DELETE: "channel_delete",
  VOICE_STATE: "voice_state",
  VOICE_LEAVE: "voice_leave",
  VOICE_CONFIG: "voice_config",
  VOICE_TOKEN: "voice_token",
  VOICE_SPEAKERS: "voice_speakers",
  MEMBER_JOIN: "member_join",
  MEMBER_LEAVE: "member_leave",
  MEMBER_UPDATE: "member_update",
  USER_UPDATE: "user_update",
  MEMBER_BAN: "member_ban",
  SERVER_RESTART: "server_restart",
  ERROR: "error",
  // Extensions (not in protocol-schema.json but used in practice)
  PONG: "pong",
  DM_CHANNEL_OPEN: "dm_channel_open",
  DM_CHANNEL_CLOSE: "dm_channel_close",
} as const;

export type ServerMessageTypeValue = (typeof ServerMessageType)[keyof typeof ServerMessageType];

// ---------------------------------------------------------------------------
// Client → Server message types
// ---------------------------------------------------------------------------

export const ClientMessageType = {
  AUTH: "auth",
  CHAT_SEND: "chat_send",
  CHAT_EDIT: "chat_edit",
  CHAT_DELETE: "chat_delete",
  REACTION_ADD: "reaction_add",
  REACTION_REMOVE: "reaction_remove",
  TYPING_START: "typing_start",
  CHANNEL_FOCUS: "channel_focus",
  PRESENCE_UPDATE: "presence_update",
  VOICE_JOIN: "voice_join",
  VOICE_LEAVE: "voice_leave",
  VOICE_MUTE: "voice_mute",
  VOICE_DEAFEN: "voice_deafen",
  VOICE_CAMERA: "voice_camera",
  VOICE_SCREENSHARE: "voice_screenshare",
  PING: "ping",
  // Extension (not in protocol-schema.json but used in practice)
  VOICE_TOKEN_REFRESH: "voice_token_refresh",
} as const;

export type ClientMessageTypeValue = (typeof ClientMessageType)[keyof typeof ClientMessageType];

// ---------------------------------------------------------------------------
// Unified MessageType — all message types in one object for convenience
// ---------------------------------------------------------------------------

export const MessageType = {
  ...ServerMessageType,
  ...ClientMessageType,
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];
