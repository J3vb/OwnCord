// Server to client payloads for voice E2EE, presence batches, members,
// roles, DMs and errors.

import type { ServerRestartReasonValue, WsErrorCodeValue } from "./protocolTypes";
import type {
  EmojiResponse,
  ReadyRole,
  StickerResponse,
  UserStatus,
  UserWithRole,
} from "./wireCommon";
import type { DmChannelPayload, GameActivity, ListeningActivity } from "./wireServer";

// ── Voice E2EE (client-side ECDH key exchange) ─────────────────────────────

/** Server→Client relay of another participant's ECDH public key. */
export interface VoiceE2EEAnnouncePayload {
  readonly user_id: number;
  readonly public_key: string;
  /** Sender's identity-key signature over the ephemeral key (F3 TOFU).
   *  Omitted for legacy clients that have not published an identity key. */
  readonly signature?: string;
  /** Identity public key (base64) of the announcing device. Peers verify
   *  `signature` against it. Absent from an older server or older peer: the
   *  receiver falls back to the member's published key. */
  readonly identity_public_key?: string;
  /** Video codecs the sender decodes (lowercase MIME subtypes). Absent from an
   *  old client or server: the receiver assumes VP8 and H.264. */
  readonly video_decode?: readonly string[];
}

/** Server→Client relay of an encrypted room key from the key holder. */
export interface VoiceE2EEOfferPayload {
  readonly from_user_id: number;
  readonly encrypted_key: string;
  readonly iv: string;
}

/** Server→Client: whose screen shares a member of the voice channel watches. */
export interface VoiceWatchingPayload {
  readonly user_id: number;
  readonly user_ids: readonly number[];
}

/** One user's presence in a presence_batch. */
export interface PresenceBatchEntry {
  readonly user_id: number;
  readonly status: UserStatus;
  /** Always present (null = none). */
  readonly custom_status: string | null;
  /** Always present on a server with `game_activity` (null = none). */
  readonly activity?: GameActivity | null;
  /** Always present on a server with `listening_activity` (null = none). */
  readonly listening?: ListeningActivity | null;
}

/** Many users' presence in one frame: a coalescing window's changes, or with
 *  `full` a snapshot of everyone online — anyone it leaves out is offline. */
export interface PresenceBatchPayload {
  readonly updates: readonly PresenceBatchEntry[];
  readonly full?: boolean;
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

/**
 * `sticker_update` — the server's whole custom-sticker set after an
 * upload, rename or delete, replaced wholesale like `emoji_update`.
 */
export interface StickerUpdatePayload {
  readonly stickers: readonly StickerResponse[];
}

/**
 * `upload_policy` — the file-type lists in force after the owner saves them in
 * the admin panel. Both are always present (`[]` when emptied) and replace the
 * lists auth_ok gave; the size cap and thumbnails stay as auth_ok set them.
 */
export interface UploadPolicyPayload {
  readonly blocked_extensions: readonly string[];
  readonly allowed_extensions: readonly string[];
}

export interface MemberUpdatePayload {
  readonly user_id: number;
  readonly role: string;
  /** Every role the member holds now, top first; absent from an older server. */
  readonly role_ids?: readonly number[];
}

export interface UserUpdatePayload {
  readonly user_id: number;
  readonly username: string;
  readonly avatar: string | null;
  /** Always present (null = cleared): user_update replaces the client's copy
   *  of the profile wholesale. */
  readonly display_name?: string | null;
  readonly about?: string | null;
  /** Always present from a server with banners (null = cleared); absent from
   *  an older one, which leaves the stored banner alone. */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
  /** Updated E2EE identity public key (base64) — lets peers detect an
   *  identity-key change (TOFU mismatch) as it happens (F3). */
  readonly identity_public_key?: string | null;
}

export interface MemberBanPayload {
  readonly user_id: number;
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

/** A Message Request's sender. `avatar` may be a stranger-controlled URL: never fetch it. */
export interface DmRequestSender {
  readonly id: number;
  readonly username: string;
  readonly display_name: string;
  readonly avatar: string;
}

/** The held first message, as plain text. Null when it has no text. */
export interface DmRequestPreview {
  readonly message_id: number;
  readonly content: string;
  readonly timestamp: string;
}

/** One pending entry of GET /api/v1/dm-requests. */
export interface DmRequestListItem {
  readonly id: number;
  readonly channel_id: number;
  readonly sender: DmRequestSender;
  readonly preview: DmRequestPreview | null;
  readonly created_at: string;
}

export type DmRequestState = "pending" | "accepted" | "ignored" | "deleted" | "blocked";

/** dm_request: sent to the recipient on creation (preview set) and on every transition (preview null). */
export interface DmRequestPayload extends DmRequestListItem {
  readonly state: DmRequestState;
  readonly decided_at: string | null;
}

export interface ServerRestartPayload {
  readonly reason: ServerRestartReasonValue;
  readonly delay_seconds: number;
  /** P5-S04: window after delay_seconds to spread the redial over (absent from older servers). */
  readonly reconnect_spread_ms?: number;
}

export interface ErrorPayload {
  readonly code: WsErrorCodeValue;
  readonly message: string;
  /** SERVER_BUSY only: the least wait before redialling. */
  readonly retry_after_ms?: number;
  /** THREAD_EXISTS only: the thread the message already has. */
  readonly thread_id?: number;
}
