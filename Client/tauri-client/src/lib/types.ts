// =============================================================================
// OwnCord Protocol Types
// All WebSocket message types, REST response types, and permission definitions.
// Source of truth: PROTOCOL.md, API.md, SCHEMA.md
// =============================================================================

// -----------------------------------------------------------------------------
// Common / Shared Types
// -----------------------------------------------------------------------------

/** Status values allowed by the protocol. */
export type UserStatus = "online" | "idle" | "dnd" | "offline";

/** Channel types supported by the server. */
export type ChannelType = "text" | "voice" | "announcement";

/** Voice quality presets. */
export type VoiceQuality = "low" | "medium" | "high";

/** Reaction action direction. */
export type ReactionAction = "add" | "remove";

/** WebSocket error codes returned by the server. */
export type WsErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "SERVER_ERROR"
  | "CHANNEL_FULL"
  | "INVALID_SDP"
  | "VOICE_ERROR"
  | "VIDEO_LIMIT";

/** REST API error codes. */
export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "TOO_LARGE"
  | "SERVER_ERROR"
  | "UNKNOWN";

// -----------------------------------------------------------------------------
// Embedded Objects (used inside payloads)
// -----------------------------------------------------------------------------

/** Minimal user object embedded in messages and member payloads. */
export interface MessageUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
}

/** User object with role, used in auth_ok and member_join. */
export interface UserWithRole extends MessageUser {
  readonly role: string;
}

/** Attachment on a chat message. */
export interface Attachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
}

/** Reaction summary on a REST message response. */
export interface ReactionSummary {
  readonly emoji: string;
  readonly count: number;
  readonly me: boolean;
}

// -----------------------------------------------------------------------------
// Ready Payload Nested Objects
// -----------------------------------------------------------------------------

/** Channel object in the ready payload. */
export interface ReadyChannel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
  readonly unread_count?: number;
  readonly last_message_id?: number;
}

/** Member object in the ready payload. */
export interface ReadyMember {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
}

/** Voice state object in the ready payload. */
export interface ReadyVoiceState {
  readonly channel_id: number;
  readonly user_id: number;
  readonly muted: boolean;
  readonly deafened: boolean;
}

/** Role object in the ready payload. */
export interface ReadyRole {
  readonly id: number;
  readonly name: string;
  readonly color: string | null;
  readonly permissions: number;
}

// -----------------------------------------------------------------------------
// Permission Bitfield (from SCHEMA.md)
// -----------------------------------------------------------------------------

export enum Permission {
  SEND_MESSAGES   = 0x1,
  READ_MESSAGES   = 0x2,
  ATTACH_FILES    = 0x20,
  ADD_REACTIONS   = 0x40,
  USE_SOUNDBOARD  = 0x100,
  CONNECT_VOICE   = 0x200,
  SPEAK_VOICE     = 0x400,
  USE_VIDEO       = 0x800,
  SHARE_SCREEN    = 0x1000,
  MANAGE_MESSAGES = 0x10000,
  MANAGE_CHANNELS = 0x20000,
  KICK_MEMBERS    = 0x40000,
  BAN_MEMBERS     = 0x80000,
  MUTE_MEMBERS    = 0x100000,
  MANAGE_ROLES    = 0x1000000,
  MANAGE_SERVER   = 0x2000000,
  MANAGE_INVITES  = 0x4000000,
  VIEW_AUDIT_LOG  = 0x8000000,
  ADMINISTRATOR   = 0x40000000,
}

// -----------------------------------------------------------------------------
// WebSocket Envelope
// -----------------------------------------------------------------------------

/** Generic WebSocket message envelope. */
export interface WsEnvelope<T> {
  readonly type: string;
  readonly id?: string;
  readonly payload: T;
}

// -----------------------------------------------------------------------------
// Server → Client Payloads
// -----------------------------------------------------------------------------

export interface AuthOkPayload {
  readonly user: UserWithRole;
  readonly server_name: string;
  readonly motd: string;
}

export interface AuthErrorPayload {
  readonly message: string;
}

export interface ReadyPayload {
  readonly channels: readonly ReadyChannel[];
  readonly members: readonly ReadyMember[];
  readonly voice_states: readonly ReadyVoiceState[];
  readonly roles: readonly ReadyRole[];
}

export interface ChatMessagePayload {
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  readonly attachments: readonly Attachment[];
  readonly timestamp: string;
}

export interface ChatSendOkPayload {
  readonly message_id: number;
  readonly timestamp: string;
}

export interface ChatEditedPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly content: string;
  readonly edited_at: string;
}

export interface ChatDeletedPayload {
  readonly message_id: number;
  readonly channel_id: number;
}

export interface ReactionUpdatePayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly emoji: string;
  readonly user_id: number;
  readonly action: ReactionAction;
}

export interface TypingPayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
}

export interface PresencePayload {
  readonly user_id: number;
  readonly status: UserStatus;
}

export interface ChannelCreatePayload {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
}

export interface ChannelUpdatePayload {
  readonly id: number;
  readonly name?: string;
  readonly position?: number;
}

export interface ChannelDeletePayload {
  readonly id: number;
}

export interface VoiceStatePayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
}

export interface VoiceLeavePayload {
  readonly channel_id: number;
  readonly user_id: number;
}

/** CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceConfigPayload {
  readonly channel_id: number;
  readonly quality: VoiceQuality;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

/** CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceSpeakersPayload {
  readonly channel_id: number;
  readonly speakers: readonly number[];
  readonly threshold_mode?: string;
}

export interface VoiceTokenPayload {
  readonly channel_id: number;
  readonly token: string;
  readonly url: string;
  readonly direct_url?: string;
}

export interface MemberJoinPayload {
  readonly user: UserWithRole;
}

export interface MemberLeavePayload {
  readonly user_id: number;
}

export interface MemberUpdatePayload {
  readonly user_id: number;
  readonly role: string;
}

export interface MemberBanPayload {
  readonly user_id: number;
}

export interface ServerRestartPayload {
  readonly reason: string;
  readonly delay_seconds: number;
}

export interface ErrorPayload {
  readonly code: WsErrorCode;
  readonly message: string;
}

// -----------------------------------------------------------------------------
// Client → Server Payloads
// -----------------------------------------------------------------------------

export interface AuthPayload {
  readonly token: string;
}

export interface ChatSendPayload {
  readonly channel_id: number;
  readonly content: string;
  readonly reply_to: number | null;
  readonly attachments: readonly string[];
}

export interface ChatEditPayload {
  readonly message_id: number;
  readonly content: string;
}

export interface ChatDeletePayload {
  readonly message_id: number;
}

export interface ReactionAddPayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface ReactionRemovePayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface TypingStartPayload {
  readonly channel_id: number;
}

export interface ChannelFocusPayload {
  readonly channel_id: number;
}

export interface PresenceUpdatePayload {
  readonly status: UserStatus;
}

export interface VoiceJoinPayload {
  readonly channel_id: number;
}

/** Client → Server: leave current voice channel (no payload needed). */
export type VoiceLeaveClientPayload = Record<string, never>;

export interface VoiceMutePayload {
  readonly muted: boolean;
}

export interface VoiceDeafenPayload {
  readonly deafened: boolean;
}

export interface VoiceCameraPayload {
  readonly enabled: boolean;
}

export interface VoiceScreensharePayload {
  readonly enabled: boolean;
}

export interface SoundboardPlayPayload {
  readonly sound_id: string;
}

// -----------------------------------------------------------------------------
// Discriminated Union: Server → Client Messages
// -----------------------------------------------------------------------------

export type ServerMessage =
  | (WsEnvelope<AuthOkPayload> & { readonly type: "auth_ok" })
  | (WsEnvelope<AuthErrorPayload> & { readonly type: "auth_error" })
  | (WsEnvelope<ReadyPayload> & { readonly type: "ready" })
  | (WsEnvelope<ChatMessagePayload> & { readonly type: "chat_message" })
  | (WsEnvelope<ChatSendOkPayload> & { readonly type: "chat_send_ok" })
  | (WsEnvelope<ChatEditedPayload> & { readonly type: "chat_edited" })
  | (WsEnvelope<ChatDeletedPayload> & { readonly type: "chat_deleted" })
  | (WsEnvelope<ReactionUpdatePayload> & { readonly type: "reaction_update" })
  | (WsEnvelope<TypingPayload> & { readonly type: "typing" })
  | (WsEnvelope<PresencePayload> & { readonly type: "presence" })
  | (WsEnvelope<ChannelCreatePayload> & { readonly type: "channel_create" })
  | (WsEnvelope<ChannelUpdatePayload> & { readonly type: "channel_update" })
  | (WsEnvelope<ChannelDeletePayload> & { readonly type: "channel_delete" })
  | (WsEnvelope<VoiceStatePayload> & { readonly type: "voice_state" })
  | (WsEnvelope<VoiceLeavePayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceConfigPayload> & { readonly type: "voice_config" })
  | (WsEnvelope<VoiceSpeakersPayload> & { readonly type: "voice_speakers" })
  | (WsEnvelope<VoiceTokenPayload> & { readonly type: "voice_token" })
  | (WsEnvelope<MemberJoinPayload> & { readonly type: "member_join" })
  | (WsEnvelope<MemberLeavePayload> & { readonly type: "member_leave" })
  | (WsEnvelope<MemberUpdatePayload> & { readonly type: "member_update" })
  | (WsEnvelope<MemberBanPayload> & { readonly type: "member_ban" })
  | (WsEnvelope<ServerRestartPayload> & { readonly type: "server_restart" })
  | (WsEnvelope<ErrorPayload> & { readonly type: "error" });

// -----------------------------------------------------------------------------
// Discriminated Union: Client → Server Messages
// -----------------------------------------------------------------------------

export type ClientMessage =
  | (WsEnvelope<AuthPayload> & { readonly type: "auth" })
  | (WsEnvelope<ChatSendPayload> & { readonly type: "chat_send" })
  | (WsEnvelope<ChatEditPayload> & { readonly type: "chat_edit" })
  | (WsEnvelope<ChatDeletePayload> & { readonly type: "chat_delete" })
  | (WsEnvelope<ReactionAddPayload> & { readonly type: "reaction_add" })
  | (WsEnvelope<ReactionRemovePayload> & { readonly type: "reaction_remove" })
  | (WsEnvelope<TypingStartPayload> & { readonly type: "typing_start" })
  | (WsEnvelope<ChannelFocusPayload> & { readonly type: "channel_focus" })
  | (WsEnvelope<PresenceUpdatePayload> & { readonly type: "presence_update" })
  | (WsEnvelope<VoiceJoinPayload> & { readonly type: "voice_join" })
  | (WsEnvelope<VoiceLeaveClientPayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceMutePayload> & { readonly type: "voice_mute" })
  | (WsEnvelope<VoiceDeafenPayload> & { readonly type: "voice_deafen" })
  | (WsEnvelope<VoiceCameraPayload> & { readonly type: "voice_camera" })
  | (WsEnvelope<VoiceScreensharePayload> & { readonly type: "voice_screenshare" })
  | (WsEnvelope<SoundboardPlayPayload> & { readonly type: "soundboard_play" });

// -----------------------------------------------------------------------------
// REST API Response Types
// -----------------------------------------------------------------------------

/** POST /api/auth/login response. */
export interface AuthResponse {
  readonly token?: string;
  readonly partial_token?: string;
  readonly requires_2fa: boolean;
}

/** POST /api/auth/register response. */
export interface RegisterResponse {
  readonly user: { readonly id: number; readonly username: string };
  readonly token: string;
}

/** GET /api/health response. */
export interface HealthResponse {
  readonly status: string;
  readonly version: string;
  readonly uptime: number;
}

/** Single channel object from REST API. */
export interface ChannelResponse {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly position: number;
}

/** Single message object from GET /api/channels/{id}/messages. */
export interface MessageResponse {
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly edited_at: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
}

/** Paginated messages response. */
export interface MessagesResponse {
  readonly messages: readonly MessageResponse[];
  readonly has_more: boolean;
}

/** Member object from REST API. */
export interface MemberResponse {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
}

/** Search result item. */
export interface SearchResultItem {
  readonly message_id: number;
  readonly channel_id: number;
  readonly channel_name: string;
  readonly user: MessageUser;
  readonly content: string;
  readonly timestamp: string;
}

/** GET /api/search response. */
export interface SearchResponse {
  readonly results: readonly SearchResultItem[];
}

/** REST API error response body. */
export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message: string;
}

/** Single emoji object from GET /api/emoji. */
export interface EmojiResponse {
  readonly id: number;
  readonly shortcode: string;
  readonly filename: string;
  readonly uploaded_by: number;
  readonly created_at: string;
}

/** Single sound object from GET /api/sounds. */
export interface SoundResponse {
  readonly id: number;
  readonly name: string;
  readonly filename: string;
  readonly duration_ms: number;
  readonly uploaded_by: number;
  readonly created_at: string;
}

/** Single invite object from GET/POST /api/invites. */
export interface InviteResponse {
  readonly id: number;
  readonly code: string;
  readonly url: string;
  readonly max_uses: number | null;
  readonly use_count?: number;
  readonly expires_at: string | null;
}

/** Single session object from GET /api/users/me/sessions. */
export interface SessionResponse {
  readonly id: number;
  readonly device: string | null;
  readonly ip_address: string | null;
  readonly created_at: string;
  readonly last_used: string;
  readonly expires_at: string;
}

/** Upload response from POST /api/uploads. */
export interface UploadResponse {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
}

/** TURN/STUN credentials from GET /api/voice/credentials. */
export interface IceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface VoiceCredentialsResponse {
  readonly ice_servers: readonly IceServer[];
  readonly expires_in: number;
}
