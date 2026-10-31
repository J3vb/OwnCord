// =============================================================================
// OwnCord Protocol Types
// All WebSocket message types, REST response types, and permission definitions.
// Source of truth: docs/protocol.md, docs/api.md, docs/schema.md
//
// The WebSocket types live in wireCommon, wireServer, wireVoiceDm, wireClient
// and wireUnions; this module re-exports them and keeps the permission enum
// and the REST types.
// =============================================================================

import { connectText } from "../i18n/connect";
import type { RestErrorCodeValue } from "./protocolTypes";
import type {
  Attachment,
  ChannelType,
  MessageStickerInfo,
  MessageUser,
  ReactionSummary,
  UserStatus,
} from "./wireCommon";
import type {
  CallInfo,
  DmChannelPayload,
  DmRecipient,
  ForwardInfo,
  GroupEventInfo,
  ImportedAuthor,
  PollInfo,
  ReferencedMessage,
  ThreadInfo,
} from "./wireServer";
import type { DmRequestListItem } from "./wireVoiceDm";
export { isTextLikeChannel } from "./wireCommon";
export type {
  UserStatus,
  ChannelType,
  ForumTag,
  ForumSettings,
  ForumSettingsBody,
  MessageUser,
  UserWithRole,
  Attachment,
  VoiceUploadMeta,
  ReactionSummary,
  ReadyChannel,
  ReadyMember,
  ReadyVoiceState,
  ReadyRole,
  ThreadAutoArchiveMinutes,
  EmojiResponse,
  StickerResponse,
  MessageStickerInfo,
} from "./wireCommon";
export type {
  AuthOkPayload,
  UploadPolicy,
  ChannelCategory,
  GameActivity,
  ReadyActivity,
  ListeningActivity,
  ReadyListening,
  ReadyPayload,
  MemberTimeoutEntry,
  ReadyNotice,
  AppealStatusPayload,
  ChannelActivityEntry,
  ImportedAuthor,
  ReferencedMessage,
  CallInfo,
  GroupEventInfo,
  ForwardInfo,
  PollAnswer,
  PollInfo,
  PollView,
  PollUpdatePayload,
  PollCreateOkPayload,
  PollVoteOkPayload,
  PollEndOkPayload,
  ThreadInfo,
  ReadyThread,
  ThreadUpdatePayload,
  ChannelMediaItem,
  ChannelMediaPage,
  ChannelMediaMonthsResponse,
  ChannelMediaQuery,
  UserStorage,
  UserUploadItem,
  UserUploadsPage,
  UserUploadsQuery,
  ThreadListResponse,
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ChatBulkDeletedPayload,
  ReactionUpdatePayload,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  VoiceStatePayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
  DmRecipient,
  DmChannelPayload,
} from "./wireServer";
export type {
  PresenceBatchEntry,
  MemberJoinPayload,
  DmRequestListItem,
  DmRequestState,
  DmRequestPayload,
} from "./wireVoiceDm";
export type { PollCreateAnswer } from "./wireClient";
export type { ServerMessage, ClientMessage } from "./wireUnions";

/**
 * Error codes the server can send: generated from `error_codes` in
 * protocol/schema.json, so a code the server adds reaches this union by
 * regenerating, not by hand. Compare against the `WsErrorCode` /
 * `RestErrorCode` constants in `@lib/protocolTypes`, never a bare string.
 */
export type { RestErrorCodeValue } from "./protocolTypes";

// -----------------------------------------------------------------------------
// Permission Bitfield (from SCHEMA.md)
// -----------------------------------------------------------------------------

export enum Permission {
  SEND_MESSAGES = 0x1,
  READ_MESSAGES = 0x2,
  MANAGE_CONFIG = 0x4,
  MANAGE_UPDATES = 0x8,
  MANAGE_TOKENS = 0x10,
  ATTACH_FILES = 0x20,
  ADD_REACTIONS = 0x40,
  ISSUE_RECOVERY = 0x80,
  VIEW_DIAGNOSTICS = 0x100,
  CONNECT_VOICE = 0x200,
  SPEAK_VOICE = 0x400,
  USE_VIDEO = 0x800,
  SHARE_SCREEN = 0x1000,
  MOVE_MEMBERS = 0x2000,
  MANAGE_BACKUPS = 0x4000,
  RESTORE_BACKUPS = 0x8000,
  MANAGE_MESSAGES = 0x10000,
  MANAGE_CHANNELS = 0x20000,
  KICK_MEMBERS = 0x40000,
  BAN_MEMBERS = 0x80000,
  MUTE_MEMBERS = 0x100000,
  MENTION_EVERYONE = 0x200000,
  MODERATE_MEMBERS = 0x400000,
  MANAGE_NICKNAMES = 0x800000,
  MANAGE_ROLES = 0x1000000,
  MANAGE_SERVER = 0x2000000,
  MANAGE_INVITES = 0x4000000,
  VIEW_AUDIT_LOG = 0x8000000,
  ERASE_ACCOUNTS = 0x10000000,
  ADMINISTRATOR = 0x40000000,
}

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
  readonly user?: { readonly id: number; readonly username: string };
  readonly token?: string;
  /** Approval-mode registration: the server answered 202 — the
   *  account exists but cannot sign in until an admin approves it. */
  readonly status?: "pending_approval";
}

/**
 * Body of the credential-change endpoints (PUT /users/me/password,
 * POST /users/me/totp/confirm, DELETE /users/me/totp) when the change
 * committed but the other sessions could not be revoked: the server answers
 * 200 with this instead of the plain 204, and the warning is the one signal
 * telling the user to revoke those sessions by hand.
 */
export interface PartialSuccessResponse {
  readonly warning?: string;
  readonly sessions_revoked?: number;
}

/** GET /api/health response. */
export interface HealthResponse {
  readonly status: string;
  /** Version is omitted from unauthenticated endpoints to prevent fingerprinting. */
  readonly version?: string;
  readonly uptime: number;
  readonly online_users: number;
}

/** Registration mode reported by `server-info`. */
export type RegistrationMode = "closed" | "invite" | "approval" | "open";

/**
 * Narrow an unknown `registration_mode` value to the union, or null for
 * anything else. The field is optional on an older server and a hand-edited
 * one can hold any string, so callers must treat null as "unknown" and fall
 * back to the invite-required behaviour — never as "open".
 */
export function parseRegistrationMode(value: unknown): RegistrationMode | null {
  switch (value) {
    case "closed":
    case "invite":
    case "approval":
    case "open":
      return value;
    default:
      return null;
  }
}

/**
 * The server-default retention sentence from a `server-info` snapshot, or null
 * when the server did not report a usable window (older server, failed read,
 * malformed value) — callers then say nothing rather than guess. Attachments
 * have no window of their own: they are deleted with their messages.
 */
export function retentionNotice(info: ServerInfoResponse | undefined): string | null {
  const days: unknown = info?.retention?.messages_days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0) return null;
  const window =
    days === 0
      ? connectText("retention.kept")
      : connectText("retention.deleted", { count: days, days: String(days) });
  return connectText("retention.notice", { window });
}

/**
 * GET /api/v1/server-info response.
 *
 * `protocol_epoch` is the wire epoch this server speaks; the client compares it
 * with `PROTOCOL_EPOCH` to know whether it can connect before opening a
 * WebSocket. There is deliberately no version field.
 *
 * `registration_mode` and a retention summary; both are optional so
 * an older server (or a failed read) leaves them undefined and consumers fall
 * back to today's invite-required behaviour. `registration_mode` is parsed
 * through `parseRegistrationMode` at the point of use — an unknown string is
 * unavailable, not a licence to widen registration.
 */
export interface ServerInfoResponse {
  readonly name: string;
  readonly protocol_epoch: number;
  readonly browser_client_enabled: boolean;
  /** Unknown/missing is treated as unavailable; see `parseRegistrationMode`. */
  readonly registration_mode?: RegistrationMode;
  /** Server-default message retention window; `messages_days: 0` = indefinitely. */
  readonly retention?: { readonly messages_days: number };
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
  /** Parent snippet. Absent from older servers; null when not a reply. */
  readonly referenced_message?: ReferencedMessage | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly edited_at: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
  /** Present on an imported message; `user` is then the hidden import account. */
  readonly imported_author?: ImportedAuthor;
  /** Server-resolved mentioned user IDs. Absent from older servers. */
  readonly mentions?: readonly number[];
  /** See ChatMessagePayload.mention_roles. */
  readonly mention_roles?: readonly number[];
  readonly mentions_everyone?: boolean;
  readonly kind?: string;
  readonly call?: CallInfo;
  /** See GroupEventInfo; present on a group DM system row only. */
  readonly group_event?: GroupEventInfo;
  /** Present on a forwarded message only. */
  readonly forward?: ForwardInfo;
  /** Present on a poll message only. */
  readonly poll?: PollInfo;
  /** Present on a sticker message only. */
  readonly sticker?: MessageStickerInfo;
  /** Present on a thread's starter message only. */
  readonly thread?: ThreadInfo;
}

/**
 * Paginated messages response. Newest-first for the default and `before`
 * pages; **oldest-first** for an `after` page (the window's downward
 * continuation, already in render order).
 */
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
  /** Whether 2FA is enrolled. Present on the caller's own GET /users/me
   *  response — the only place the server states it. */
  readonly totp_enabled?: boolean;
  readonly display_name?: string | null;
  readonly about?: string | null;
  readonly banner?: string | null;
  readonly banner_color?: string | null;
  readonly custom_status?: string | null;
}

/**
 * One user row from the admin API (`GET /api/v1/moderation/members`), the shape
 * `toAdminUserResponse` writes (Server/admin/types.go). Distinct from
 * `MemberResponse`: this one carries the ban state the moderation surface
 * needs, and the list is paged server-side.
 */
export interface AdminUser {
  readonly id: number;
  readonly username: string;
  readonly avatar?: string | null;
  readonly role_id: number;
  readonly role_name: string;
  /** Every held role, top role first; only the users list sends it. */
  readonly role_ids?: readonly number[];
  readonly status: UserStatus;
  readonly created_at: string;
  readonly last_seen?: string;
  readonly banned: boolean;
  readonly ban_reason?: string;
  readonly ban_expires?: string;
}

/** Search result item. */
export interface SearchResultItem {
  readonly message_id: number;
  readonly channel_id: number;
  readonly channel_name: string;
  readonly user: MessageUser;
  readonly content: string;
  readonly timestamp: string;
  /** Present on an imported message; `user` is then the hidden import account. */
  readonly imported_author?: ImportedAuthor;
}

/** GET /api/search response. */
export interface SearchResponse {
  readonly results: readonly SearchResultItem[];
  /**
   * Cursor for the next page of a newest-first (`sort=recent`) search, or null
   * or absent when there is none. Only `recent` paging sets it.
   */
  readonly next_before?: number | null;
}

/** REST API error response body. */
export interface ApiError {
  /** UNKNOWN: the client's own fallback for a reply with no JSON error body. */
  readonly error: RestErrorCodeValue | "UNKNOWN";
  readonly message: string;
}

/** Single invite object from GET/POST /api/invites. */
export interface InviteResponse {
  readonly id: number;
  readonly code: string;
  readonly url: string;
  readonly max_uses: number | null;
  readonly use_count?: number;
  readonly expires_at: string | null;
  readonly revoked?: boolean;
  readonly created_at?: string;
  readonly creator_username?: string;
}

/** Upload response from POST /api/uploads. */
export interface UploadResponse {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly url: string;
  readonly duration_ms?: number;
  readonly waveform?: string;
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

/** One saved GIF (GET /api/v1/gif/favorites). */
export interface GifFavorite {
  readonly url: string;
  readonly preview_url: string;
  readonly title: string;
}

export interface GifFavoritesResponse {
  readonly favorites: readonly GifFavorite[];
}

/** Envelope for both GIF endpoints. */
export interface GifSearchResponse {
  readonly results: readonly GifApiResult[];
  /** Opaque cursor for the next page (send back as `pos`); "" or absent when there is none. */
  readonly next?: string;
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

/** GET /api/v1/dm-requests response: the caller's pending inbox, newest first. */
export interface DmRequestListResponse {
  readonly requests: readonly DmRequestListItem[];
}

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
