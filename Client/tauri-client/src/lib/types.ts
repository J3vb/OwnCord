// =============================================================================
// OwnCord Protocol Types
// All WebSocket message types, REST response types, and permission definitions.
// Source of truth: docs/protocol.md, docs/api.md, docs/schema.md
// =============================================================================

// -----------------------------------------------------------------------------
// Common / Shared Types
// -----------------------------------------------------------------------------

/**
 * Status values allowed by the protocol.
 *
 * "invisible" is a real, settable status since phase 6: the server stores it
 * as chosen and maps it to "offline" for every OTHER user, so the owner keeps
 * seeing their own true state. "offline" is what the server broadcasts for a
 * user with no live session — it is no longer something a user picks.
 */
export type UserStatus = "online" | "idle" | "dnd" | "invisible" | "offline";

/** Channel types supported by the server. */
export type ChannelType = "text" | "voice" | "announcement" | "dm";

/** Voice quality presets. */
export type VoiceQuality = "low" | "medium" | "high";

/** Reaction action direction. */
export type ReactionAction = "add" | "remove";

/** WebSocket error codes returned by the server. */
/**
 * Error codes the server can send over the socket. Mirrors
 * `Server/ws/errors.go` — the union was missing more than half of them
 * (SLOW_MODE, CONFLICT, BAD_REQUEST…), so code that switched on it could not
 * name the cases the server actually emits.
 */
export type WsErrorCode =
  | "BAD_REQUEST"
  | "INTERNAL"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "ALREADY_JOINED"
  | "CHANNEL_FULL"
  | "VOICE_ERROR"
  | "VIDEO_LIMIT"
  | "BANNED"
  | "INVALID_JSON"
  | "UNKNOWN_TYPE"
  | "SLOW_MODE"
  | "CONFLICT"
  | "BAD_PAYLOAD"
  | "NOT_KEY_HOLDER"
  // Kept for older servers / existing call sites.
  | "INVALID_INPUT"
  | "SERVER_ERROR";

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
  /** GIF proxy is not configured on this server (no gif.api_key). */
  | "GIF_DISABLED"
  | "UNKNOWN";

// -----------------------------------------------------------------------------
// Embedded Objects (used inside payloads)
// -----------------------------------------------------------------------------

/** Minimal user object embedded in messages and member payloads. */
export interface MessageUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  /** Nickname to render instead of `username`. Absent/null = use `username`.
   *  Mentions still resolve against `username`, which is the unique handle. */
  readonly display_name?: string | null;
}

/** User object with role, used in auth_ok and member_join. */
export interface UserWithRole extends MessageUser {
  readonly role: string;
  readonly totp_enabled?: boolean;
  /** The signed-in user's own profile text. Null = unset. */
  readonly about?: string | null;
  readonly custom_status?: string | null;
  /** The signed-in user's OWN true status, "invisible" included. Only ever
   *  present on their own auth_ok / REST me payload. */
  readonly status?: UserStatus;
  /** Long-term E2EE identity public key (base64), pinned by peers on first
   *  sight (F3 TOFU). Omitted/null when the user has not published one. */
  readonly identity_public_key?: string | null;
}

/** Attachment on a chat message. */
export interface Attachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
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
  /** Channel topic ("" = none). Absent from older servers. */
  readonly topic?: string;
  readonly position: number;
  readonly unread_count?: number;
  readonly last_message_id?: number;
  /**
   * Whether the current user may post in this channel — authoritative,
   * server-computed (base role ± channel overrides, admin bypass, and the
   * announcement MANAGE_MESSAGES rule). Drives the composer affordance; the
   * server still enforces. Absent from older servers.
   */
  readonly can_send?: boolean;
  /**
   * Per-channel cooldown in seconds (0 = off). Drives the composer's
   * slow-mode countdown; the server still enforces. Absent from older servers.
   */
  readonly slow_mode?: number;
  /**
   * Unread messages in this channel that mention the current user (directly or
   * via @everyone/@here). Always ≤ unread_count. Absent from older servers.
   */
  readonly mention_count?: number;
  /**
   * Whether the channel is flagged as possibly carrying sensitive content.
   * A pure label: the server stores and ships it but applies no content
   * behaviour of its own, so what it means is entirely this client's choice
   * (a one-time-per-session age gate and a sidebar marker). Absent from older
   * servers, which is read as "not flagged".
   */
  readonly nsfw?: boolean;
  /**
   * Voice capacity limits (0 = unlimited), the same values the server enforces
   * on join with CHANNEL_FULL / VIDEO_LIMIT. Shipped so the sidebar can show
   * "3/5"; the client enforces nothing. Absent from older servers.
   */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
}

/** Member object in the ready payload. */
export interface ReadyMember {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** Nickname to render instead of `username`. Null = unset. */
  readonly display_name?: string | null;
  /** Free-text status line shown under the name. Null = unset. */
  readonly custom_status?: string | null;
  /** Long-term E2EE identity public key (base64) for voice TOFU (F3). */
  readonly identity_public_key?: string | null;
}

/** Voice state object in the ready payload. */
export interface ReadyVoiceState {
  readonly channel_id: number;
  readonly user_id: number;
  readonly muted: boolean;
  readonly deafened: boolean;
  /** Moderator-imposed; optional so an older server's payload still parses. */
  readonly server_muted?: boolean;
  readonly server_deafened?: boolean;
}

/** Role object in the ready payload and in roles_update. */
export interface ReadyRole {
  readonly id: number;
  readonly name: string;
  readonly color: string | null;
  readonly permissions: number;
  /**
   * Hierarchy rank — higher outranks lower. Optional because servers predating
   * role management shipped the list without it; nothing in the client sorts
   * on it yet, but role management makes positions mutable, so a stale copy
   * must be replaceable rather than inferred from list order.
   */
  readonly position?: number;
  /** True for the fallback role members land on when their role is deleted. */
  readonly is_default?: boolean;
}

// -----------------------------------------------------------------------------
// Permission Bitfield (from SCHEMA.md)
// -----------------------------------------------------------------------------

export enum Permission {
  SEND_MESSAGES = 0x1,
  READ_MESSAGES = 0x2,
  ATTACH_FILES = 0x20,
  ADD_REACTIONS = 0x40,
  CONNECT_VOICE = 0x200,
  SPEAK_VOICE = 0x400,
  USE_VIDEO = 0x800,
  SHARE_SCREEN = 0x1000,
  MANAGE_MESSAGES = 0x10000,
  MANAGE_CHANNELS = 0x20000,
  KICK_MEMBERS = 0x40000,
  BAN_MEMBERS = 0x80000,
  MUTE_MEMBERS = 0x100000,
  MENTION_EVERYONE = 0x200000,
  MANAGE_ROLES = 0x1000000,
  MANAGE_SERVER = 0x2000000,
  MANAGE_INVITES = 0x4000000,
  VIEW_AUDIT_LOG = 0x8000000,
  ADMINISTRATOR = 0x40000000,
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
  readonly dm_channels?: readonly DmChannelPayload[];
}

export interface ChatMessagePayload {
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  readonly attachments: readonly Attachment[];
  readonly timestamp: string;
  /**
   * Server-resolved user IDs this message mentions, ordered by first
   * appearance. Absent from older servers — callers fall back to resolving
   * @tokens against the member list. Never contains @everyone/@here.
   */
  readonly mentions?: readonly number[];
  /**
   * Whether an @everyone/@here in the content cleared the sender's
   * MENTION_EVERYONE gate. A token without the bit carries no mention
   * semantics at all. Absent from older servers.
   */
  readonly mentions_everyone?: boolean;
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
  /** Re-resolved mentions for the new content. An edit never re-notifies. */
  readonly mentions?: readonly number[];
  readonly mentions_everyone?: boolean;
}

export interface ChatDeletedPayload {
  readonly message_id: number;
  readonly channel_id: number;
}

/** Bulk moderator delete (channel purge). `ids` is newest-first and never null. */
export interface ChatBulkDeletedPayload {
  readonly channel_id: number;
  readonly ids: readonly number[];
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
  /** The user's current custom status line. Always present on the wire
   *  (null = none), so a cleared text is distinguishable from an event that
   *  simply does not mention it. */
  readonly custom_status?: string | null;
}

export interface ChannelCreatePayload {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  readonly topic?: string;
  readonly position: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — a label the server never acts on. */
  readonly nsfw?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
}

export interface ChannelUpdatePayload {
  readonly id: number;
  readonly name?: string;
  readonly topic?: string;
  /**
   * The category the channel now sits under ("" = uncategorized). Moving a
   * channel between categories is an edit, so the broadcast carries it and
   * the sidebar regroups without a reconnect.
   */
  readonly category?: string | null;
  readonly position?: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — a label the server never acts on. */
  readonly nsfw?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
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
  /** Moderator-imposed; the user cannot lift these themselves. Optional so an
   *  older server's payload still parses. */
  readonly server_muted?: boolean;
  readonly server_deafened?: boolean;
}

/** Server -> Client: a moderator moved this client to another voice channel. */
export interface VoiceMovedPayload {
  readonly to_channel_id: number;
}

/** Server -> Client: a moderator removed this client from voice. */
export interface VoiceDisconnectedPayload {
  readonly channel_id: number;
  readonly reason: string;
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
  readonly is_key_holder?: boolean;
}

// ── Voice E2EE (client-side ECDH key exchange) ─────────────────────────────

/** Server→Client relay of another participant's ECDH public key. */
export interface VoiceE2EEAnnouncePayload {
  readonly user_id: number;
  readonly public_key: string;
  /** Sender's identity-key signature over the ephemeral key (F3 TOFU).
   *  Omitted for legacy clients that have not published an identity key. */
  readonly signature?: string;
}

/** Server→Client relay of an encrypted room key from the key holder. */
export interface VoiceE2EEOfferPayload {
  readonly from_user_id: number;
  readonly encrypted_key: string;
  readonly iv: string;
}

export interface MemberJoinPayload {
  readonly user: UserWithRole;
  /** Viewer-safe presence the connecting user comes online as (broadcast
   *  collapse of their real status — an invisible connector reports
   *  "offline" here, never their true chosen status). Optional only for
   *  compatibility with an older server that omits it; a caller MUST treat a
   *  missing value as "offline", not assume "online", so a hidden user does
   *  not render visible just because the field wasn't sent yet. */
  readonly status?: UserStatus;
}

export interface MemberLeavePayload {
  readonly user_id: number;
}

/**
 * Full role list after any role mutation. The server sends the whole list
 * rather than a delta, so the store is replaced wholesale — a dropped
 * intermediate event can never leave a deleted role on screen.
 */
export interface RolesUpdatePayload {
  readonly roles: readonly ReadyRole[];
}

/**
 * `emoji_update` — the server's whole custom-emoji set after an upload or a
 * delete. Whole-set for the same reason roles_update is: the client replaces
 * its map rather than patching it, so a dropped event cannot leave a deleted
 * emoji rendering.
 */
export interface EmojiUpdatePayload {
  readonly emoji: readonly EmojiResponse[];
}

export interface MemberUpdatePayload {
  readonly user_id: number;
  readonly role: string;
}

export interface UserUpdatePayload {
  readonly user_id: number;
  readonly username: string;
  readonly avatar: string | null;
  /** Always present (null = cleared): user_update replaces the client's copy
   *  of the profile wholesale. */
  readonly display_name?: string | null;
  readonly about?: string | null;
  /** Updated E2EE identity public key (base64) — lets peers detect an
   *  identity-key change (TOFU mismatch) as it happens (F3). */
  readonly identity_public_key?: string | null;
}

export interface MemberBanPayload {
  readonly user_id: number;
}

// -----------------------------------------------------------------------------
// DM Payloads (Server → Client)
// -----------------------------------------------------------------------------

/** DM recipient object in DM channel payloads. */
export interface DmRecipient {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
  /** Chosen nickname, "" when unset. Absent from pre-phase-6 servers. */
  readonly display_name?: string;
}

/** DM channel object in ready payload and dm_channel_open event. */
export interface DmChannelPayload {
  readonly channel_id: number;
  /**
   * The other participant of a 1:1 DM. Retained for backward compatibility;
   * for a group it carries the first of `recipients` so an older payload
   * shape still renders something. Prefer `recipients`.
   */
  readonly recipient: DmRecipient;
  /**
   * Every participant except the current user. Absent from pre-group servers,
   * where `recipient` is the whole membership.
   */
  readonly recipients?: readonly DmRecipient[];
  /** Optional group name. "" (or absent) for a 1:1 DM. */
  readonly name?: string;
  /** True for a group DM. Absent from pre-group servers, which had none. */
  readonly is_group?: boolean;
  readonly last_message_id: number | null;
  readonly last_message: string;
  readonly last_message_at: string;
  readonly unread_count: number;
  /**
   * Unread messages in this DM that mention the current user. Absent from
   * older servers, which shipped no DM mention state at all — treat as 0.
   */
  readonly mention_count?: number;
}

/** dm_channel_open carries the same shape as a ready-payload DM entry. */
export type DmChannelOpenPayload = DmChannelPayload;

/** call_incoming / call_declined. Ephemeral: there is no call id because a
 *  call is presence in the DM's voice channel, not a server-side record. */
export interface CallSignalPayload {
  readonly channel_id: number;
  readonly from_user: number;
  readonly username: string;
}

/** call_ring / call_decline (client → server). */
export interface CallSignalRequestPayload {
  readonly channel_id: number;
}

export interface DmChannelClosePayload {
  readonly channel_id: number;
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
  readonly last_seq?: number;
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

/**
 * mark_read — advance the read state for a channel the user is *not* viewing.
 * Same shape as channel_focus, deliberately a different message: focus also
 * rebinds the connection's focused channel, which would be wrong here.
 */
export interface MarkReadPayload {
  readonly channel_id: number;
}

export interface PresenceUpdatePayload {
  readonly status: UserStatus;
  /** Omitted = leave the stored text alone (what the auto-idle timer sends);
   *  "" = clear it. */
  readonly custom_status?: string;
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

/** Client -> Server: moderator sets another user's server mute. channel_id is
 *  the channel the moderator sees them in; the server refuses a mismatch. */
export interface VoiceModMutePayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly muted: boolean;
}

export interface VoiceModDeafenPayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly deafened: boolean;
}

export interface VoiceModMovePayload {
  readonly user_id: number;
  readonly to_channel_id: number;
}

export interface VoiceModKickPayload {
  readonly user_id: number;
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
  | (WsEnvelope<ChatBulkDeletedPayload> & { readonly type: "chat_bulk_deleted" })
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
  | (WsEnvelope<VoiceMovedPayload> & { readonly type: "voice_moved" })
  | (WsEnvelope<VoiceDisconnectedPayload> & { readonly type: "voice_disconnected" })
  | (WsEnvelope<VoiceE2EEAnnouncePayload> & { readonly type: "voice_e2ee_announce" })
  | (WsEnvelope<VoiceE2EEOfferPayload> & { readonly type: "voice_e2ee_offer" })
  | (WsEnvelope<MemberJoinPayload> & { readonly type: "member_join" })
  | (WsEnvelope<MemberLeavePayload> & { readonly type: "member_leave" })
  | (WsEnvelope<MemberUpdatePayload> & { readonly type: "member_update" })
  | (WsEnvelope<UserUpdatePayload> & { readonly type: "user_update" })
  | (WsEnvelope<MemberBanPayload> & { readonly type: "member_ban" })
  | (WsEnvelope<RolesUpdatePayload> & { readonly type: "roles_update" })
  | (WsEnvelope<EmojiUpdatePayload> & { readonly type: "emoji_update" })
  | (WsEnvelope<DmChannelOpenPayload> & { readonly type: "dm_channel_open" })
  | (WsEnvelope<DmChannelClosePayload> & { readonly type: "dm_channel_close" })
  | (WsEnvelope<CallSignalPayload> & { readonly type: "call_incoming" })
  | (WsEnvelope<CallSignalPayload> & { readonly type: "call_declined" })
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
  | (WsEnvelope<MarkReadPayload> & { readonly type: "mark_read" })
  | (WsEnvelope<PresenceUpdatePayload> & { readonly type: "presence_update" })
  | (WsEnvelope<VoiceJoinPayload> & { readonly type: "voice_join" })
  | (WsEnvelope<VoiceLeaveClientPayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceMutePayload> & { readonly type: "voice_mute" })
  | (WsEnvelope<VoiceDeafenPayload> & { readonly type: "voice_deafen" })
  | (WsEnvelope<VoiceCameraPayload> & { readonly type: "voice_camera" })
  | (WsEnvelope<VoiceScreensharePayload> & { readonly type: "voice_screenshare" })
  | (WsEnvelope<VoiceModMutePayload> & { readonly type: "voice_mod_mute" })
  | (WsEnvelope<VoiceModDeafenPayload> & { readonly type: "voice_mod_deafen" })
  | (WsEnvelope<VoiceModMovePayload> & { readonly type: "voice_mod_move" })
  | (WsEnvelope<VoiceModKickPayload> & { readonly type: "voice_mod_kick" })
  | (WsEnvelope<Record<string, never>> & { readonly type: "voice_token_refresh" })
  | (WsEnvelope<{ public_key: string; signature?: string }> & {
      readonly type: "voice_e2ee_announce";
    })
  | (WsEnvelope<{ target_user_id: number; encrypted_key: string; iv: string }> & {
      readonly type: "voice_e2ee_offer";
    })
  | (WsEnvelope<CallSignalRequestPayload> & { readonly type: "call_ring" })
  | (WsEnvelope<CallSignalRequestPayload> & { readonly type: "call_decline" });

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
  /** Version is omitted from unauthenticated endpoints to prevent fingerprinting. */
  readonly version?: string;
  readonly uptime: number;
  readonly online_users: number;
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
  /** Server-resolved mentioned user IDs. Absent from older servers. */
  readonly mentions?: readonly number[];
  readonly mentions_everyone?: boolean;
}

/** Paginated messages response. */
export interface MessagesResponse {
  readonly messages: readonly MessageResponse[];
  readonly has_more: boolean;
}

/**
 * A window of history centred on one message, from
 * `GET /channels/{id}/messages/around/{messageId}`.
 *
 * Unlike {@link MessagesResponse}, `messages` is **oldest-first** — it is
 * already in render order and must not be reversed. `has_more_after` true
 * means the window is detached from the live tail.
 */
export interface MessagesAroundResponse {
  readonly messages: readonly MessageResponse[];
  readonly has_more_before: boolean;
  readonly has_more_after: boolean;
}

/** One reactor in the who-reacted list. `avatar` is `""` when unset. */
export interface ReactionUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
}

/**
 * Who reacted to a message with one emoji, from
 * `GET /channels/{id}/messages/{messageId}/reactions/{emoji}/users`.
 * Ordered oldest reaction first and capped at 100 by the server.
 */
export interface ReactionUsersResponse {
  readonly users: readonly ReactionUser[];
}

/** Result of a channel purge — the ids actually soft-deleted, newest-first. */
export interface PurgeResponse {
  readonly channel_id: number;
  readonly ids: readonly number[];
  readonly count: number;
}

/** Member object from REST API. */
export interface MemberResponse {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  readonly display_name?: string | null;
  readonly about?: string | null;
  readonly custom_status?: string | null;
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

/**
 * Single custom emoji from GET/POST /api/v1/emoji.
 *
 * `url` is server-relative and behind the session token — it is fetched the
 * same authenticated, cert-pinned way attachments are, never assigned straight
 * to an <img src>.
 */
export interface EmojiResponse {
  readonly id: number;
  readonly shortcode: string;
  readonly url: string;
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

/**
 * GET /api/v1/gif/{search,trending} response.
 *
 * The GIF provider key lives on the server; the client only ever talks to its
 * own server here. The media URLs still point at Klipy's CDN and are validated
 * against the CDN allowlist in gifProvider before being rendered.
 */
export interface GifApiResult {
  readonly id: string;
  readonly title: string;
  readonly media_formats: {
    readonly tinygif?: { readonly url: string };
    readonly gif?: { readonly url: string };
  };
}

/** Envelope for both GIF endpoints. */
export interface GifSearchResponse {
  readonly results: readonly GifApiResult[];
}

/** GET /api/v1/dms response. */
export interface DmChannelsResponse {
  readonly dm_channels: readonly DmChannelPayload[];
}

/** POST /api/v1/dms response. */
export interface CreateDmResponse {
  readonly channel_id: number;
  readonly recipient: DmRecipient;
  readonly created: boolean;
}

/** POST /api/v1/dms/group and PATCH /api/v1/dms/{id} both answer with the
 *  same DM summary shape the list and the ready payload use. */
export type GroupDmResponse = DmChannelPayload;

/** GET /api/v1/blocks response. */
export interface BlockedUsersResponse {
  readonly blocked_user_ids: readonly number[];
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
