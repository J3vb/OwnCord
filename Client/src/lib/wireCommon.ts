// Protocol types shared by many payloads: common shapes, embedded objects,
// the ready payload's nested objects and the WebSocket envelope.

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
export type ChannelType = "text" | "voice" | "announcement" | "dm" | "forum";

/** A forum tag as the server states it. `position` is its place in the forum's list. */
export interface ForumTag {
  readonly id: number;
  readonly name: string;
  readonly emoji?: string;
  readonly position: number;
}

/** A forum's tags and settings, on a `type: "forum"` channel only. */
export interface ForumSettings {
  readonly tags: readonly ForumTag[];
  readonly require_tag: boolean;
  readonly default_auto_archive_minutes: 60 | 1440 | 4320 | 10080;
}

/** The body of `PUT .../channels/{id}/forum`: the whole settings; a tag without `id` is created. */
export interface ForumSettingsBody {
  readonly tags: readonly {
    readonly id?: number;
    readonly name: string;
    readonly emoji?: string;
  }[];
  readonly require_tag: boolean;
  readonly default_auto_archive_minutes: ThreadAutoArchiveMinutes;
}

/**
 * True for channel types that carry a message history and a chat pane —
 * "text" and "announcement". The server treats both identically for ready's
 * unread_count/last_message_id and can_send (Server/ws/serve_ready.go), and
 * the client renders both in the sidebar with a composer. Callers that pick
 * an automatic/fallback active channel from a channel list must use this
 * instead of a bare `type === "text"` check, or an announcement-only server
 * (or a role that can only read announcement channels) lands on a blank pane
 * even though a readable channel exists.
 */
export function isTextLikeChannel(ch: { readonly type: ChannelType }): boolean {
  return ch.type === "text" || ch.type === "announcement";
}

/** Voice quality presets. */
export type VoiceQuality = "low" | "medium" | "high";

/** Reaction action direction. */
export type ReactionAction = "add" | "remove";

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
  /** Every role the user holds, top role first. Absent from an older
   *  server, where `role` is the only role. */
  readonly role_ids?: readonly number[];
  readonly totp_enabled?: boolean;
  /** The user's profile text. Null = unset. Sent for every member since the
   *  server's 3C-7 (absent from older servers). */
  readonly about?: string | null;
  /** Profile banner image path (`/api/v1/files/<id>`). Null = none, absent =
   *  older server. */
  readonly banner?: string | null;
  /** Profile banner colour (`#rgb` / `#rrggbb`). Null = none, absent = older server. */
  readonly banner_color?: string | null;
  /** Account creation time (RFC3339), the "Member since" date. Absent from
   *  older servers. */
  readonly created_at?: string;
  readonly custom_status?: string | null;
  /** RFC 3339 instant the signed-in user's OWN custom status clears itself;
   *  null = no expiry. Only on their own auth_ok / REST me payload. */
  readonly custom_status_expires_at?: string | null;
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
  /** Length of a voice message in ms. With `waveform`, the attachment is one. */
  readonly duration_ms?: number;
  /** A voice message's loudness, base64url (no padding) bytes 0-255, one per bar. */
  readonly waveform?: string;
}

/** The length and waveform an upload declares to be a voice message. */
export interface VoiceUploadMeta {
  readonly durationMs: number;
  /** base64url without padding, 1..256 bytes decoded. */
  readonly waveform: string;
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
  /** The category's id, 0 when none. Absent from older servers: group by `category`. */
  readonly category_id?: number;
  /** The category's place in the category order, 0 when none. */
  readonly category_position?: number;
  /** Channel topic ("" = none). Absent from older servers. */
  readonly topic?: string;
  /** Tags and settings of a forum channel; absent on every other type and from older servers. */
  readonly forum?: ForumSettings;
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
   * Whether the current user may mute, deafen, move or disconnect voice
   * participants in this channel — server-computed from the same authorizer
   * voice moderation enforces (base MUTE_MEMBERS, then effective
   * READ|MUTE_MEMBERS after channel overrides). Target rank and move capacity
   * stay server-side refusals. Absent from older servers.
   */
  readonly can_moderate_voice?: boolean;
  /**
   * Whether the current user may move voice participants in this channel at
   * any rank (MOVE_MEMBERS), independent of can_moderate_voice: a
   * role with only Move Members moves but cannot mute, deafen or disconnect.
   * Absent from older servers.
   */
  readonly can_move_voice?: boolean;
  /**
   * Whether the current user may delete other people's messages here, as the
   * server computed it from the channel's effective permissions. Absent from
   * older servers: fall back to the role's MANAGE_MESSAGES, never to false.
   */
  readonly can_delete_others?: boolean;
  /** Whether the current user may pin and unpin here. Same absent rule as can_delete_others. */
  readonly can_pin?: boolean;
  /** Whether the current user may react here. Absent from older servers: treat as true. */
  readonly can_react?: boolean;
  /**
   * Per-channel cooldown in seconds (0 = off). Drives the composer's
   * slow-mode countdown; the server still enforces. Absent from older servers.
   */
  readonly slow_mode?: number;
  /**
   * Unread messages in this channel that mention the current user (directly or
   * via @everyone/@here). Not capped, so it can exceed the capped unread_count.
   * Absent from older servers.
   */
  readonly mention_count?: number;
  /**
   * The caller's read pointer: the id of the last message they have read here
   * (0 = nothing read). The NEW line goes on the first message above it.
   * Absent from servers before the read pointer (and for voice channels): the
   * client then keeps its count-based NEW line.
   */
  readonly last_read_message_id?: number;
  /**
   * Whether the channel is labelled age-restricted. The server enforces it:
   * none of its content reaches a caller without their own
   * acknowledgement. Absent from older servers, which is read as "not
   * labelled".
   */
  readonly nsfw?: boolean;
  /**
   * Whether this is the server's AFK voice channel (migration 068): members
   * idle past the server's timeout are moved here, and it is listen-only.
   * Absent from older servers, which is read as "not the AFK channel".
   */
  readonly afk?: boolean;
  /**
   * Whether the channel is private: @everyone cannot see it (a permission
   * override hides it), worked out per channel, not per viewer. Sent on every
   * guild channel, never on DMs; absent from older servers, which is read as
   * "not private". Drives the sidebar's lock badge only.
   */
  readonly private?: boolean;
  /**
   * Whether the CALLER has acknowledged this labelled channel — per
   * account, so every device inherits it. Always false for an unlabelled
   * channel. Absent reads as "not acknowledged": the gate fails closed.
   */
  readonly nsfw_acknowledged?: boolean;
  /**
   * Voice capacity limits (0 = unlimited), the same values the server enforces
   * on join with CHANNEL_FULL / VIDEO_LIMIT. Shipped so the sidebar can show
   * "3/5"; the client enforces nothing. Absent from older servers.
   */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /**
   * A voice channel that asks for a password on join. Absent from older
   * servers, which read as unprotected. The password itself is never sent.
   */
  readonly password_protected?: boolean;
}

/** Member object in the ready payload. */
export interface ReadyMember {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  /** Every role the member holds, top role first. Absent from an
   *  older server, where `role` is the only role. */
  readonly role_ids?: readonly number[];
  readonly status: UserStatus;
  /** True when the member is on the Android app. Absent = not (the server
   *  omits it when false, and for an offline member). */
  readonly mobile?: boolean;
  /** Nickname to render instead of `username`. Null = unset. */
  readonly display_name?: string | null;
  /** Free-text status line shown under the name. Null = unset. */
  readonly custom_status?: string | null;
  /** Profile text. Null = unset; absent from servers before 3C-7. */
  readonly about?: string | null;
  /** Banner image path; absent = none (omitted for members without one). */
  readonly banner?: string | null;
  /** Banner colour; absent = none. */
  readonly banner_color?: string | null;
  /** Account creation time (RFC3339); absent from servers before 3C-7. */
  readonly created_at?: string;
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
  /** Live video publications; optional so an older server's payload still parses. */
  readonly camera?: boolean;
  readonly screenshare?: boolean;
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
  /** The role is its own member-list group. Absent means an older
   *  server: every role counts as hoisted. */
  readonly hoist?: boolean;
  /** Any member may ping the role. Absent = not mentionable. */
  readonly mentionable?: boolean;
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

/** The idle periods a thread can auto-archive after, in minutes. */
export type ThreadAutoArchiveMinutes = 60 | 1440 | 4320 | 10080;

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

/**
 * One custom sticker from GET/POST/PATCH /api/v1/stickers and `sticker_update`.
 * `url` is server-relative and behind the session token, like an emoji's.
 */
export interface StickerResponse {
  readonly id: number;
  readonly name: string;
  readonly emoji: string | null;
  readonly url: string;
}

/**
 * The `sticker` block of a sticker message, live and in history.
 * `name` is the label kept from send time; `id` and `url` are null once the
 * sticker has been deleted.
 */
export interface MessageStickerInfo {
  readonly id: number | null;
  readonly name: string;
  readonly url: string | null;
}
