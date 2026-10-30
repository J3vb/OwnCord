// =============================================================================
// OwnCord Protocol Types
// All WebSocket message types, REST response types, and permission definitions.
// Source of truth: docs/protocol.md, docs/api.md, docs/schema.md
// =============================================================================

import { connectText } from "../i18n/connect";
import type {
  RestErrorCodeValue,
  ServerRestartReasonValue,
  WsErrorCode,
  WsErrorCodeValue,
} from "./protocolTypes";

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

/**
 * Error codes the server can send: generated from `error_codes` in
 * protocol/schema.json, so a code the server adds reaches this union by
 * regenerating, not by hand. Compare against the `WsErrorCode` /
 * `RestErrorCode` constants in `@lib/protocolTypes`, never a bare string.
 */
export type { RestErrorCodeValue, WsErrorCodeValue } from "./protocolTypes";

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
  /**
   * Which reconnection tier served this auth_ok — "none" (fresh connect or
   * full re-sync), "buffer" (ring-buffer resume), or "db" (persisted-event
   * resume). Absent on some older servers. ws.ts resets its lastSeq
   * watermark on "none" since a full re-sync means the server's own seq
   * counter may have restarted below the client's stale watermark.
   */
  readonly replay_source?: "none" | "buffer" | "db";
  /** What the composer checks before an upload; absent on older servers. */
  readonly upload_policy?: UploadPolicy;
  /**
   * Whether game activity is shown on this server right now. Sent
   * on every connect and resume; absent on older servers.
   */
  readonly game_activity_policy?: GameActivityPolicyPayload;
}

/** auth_ok's upload_policy. The server's upload route stays authoritative. */
export interface UploadPolicy {
  /** upload.max_size_mb in bytes; 0 means uploads are disabled; absent falls back to 100 MiB. */
  readonly max_upload_bytes?: number;
  /** Extensions refused as a file name's final extension. */
  readonly blocked_extensions?: readonly string[];
  /** Non-empty: allow-only mode, the final extension must be listed. */
  readonly allowed_extensions?: readonly string[];
  /** The server serves an image's bounded preview at /api/v1/files/{id}/thumb. */
  readonly thumbnails?: boolean;
}

export interface AuthErrorPayload {
  readonly message: string;
  /**
   * Set only when the server refused this client's protocol epoch
   * (`"protocol_epoch_unsupported"`); the epochs say which side is older.
   * Absent on every other refusal.
   */
  readonly code?: typeof WsErrorCode.protocol_epoch_unsupported;
  readonly client_epoch?: number;
  readonly server_epoch?: number;
  readonly min_epoch?: number;
}

/** One channel category, as the managers' list carries it. */
export interface ChannelCategory {
  readonly id: number;
  readonly name: string;
  readonly position: number;
}

/** channel_categories — the managers' full category list, replacing what they hold. */
export interface ChannelCategoriesPayload {
  readonly categories: readonly ChannelCategory[];
}

/** The game a member is playing, as it rides `presence` and `activity_update`. */
export interface GameActivity {
  readonly name: string;
  /** Unix milliseconds the game started (the server clamps it to the last 24 h). */
  readonly started_at: number;
}

/** One entry of `ready.activities`. */
export interface ReadyActivity extends GameActivity {
  readonly user_id: number;
}

/** The song a member is listening to, as it rides `presence` and `listening_update`. */
export interface ListeningActivity {
  readonly title: string;
  /** May be empty. */
  readonly artist: string;
  /** The app that plays it ("Spotify"). */
  readonly player: string;
  /** Unix milliseconds the song would have started at (now minus the position). */
  readonly started_at: number;
  /** The song's length in milliseconds; 0 = unknown. */
  readonly duration_ms: number;
}

/** One entry of `ready.listening`. */
export interface ReadyListening extends ListeningActivity {
  readonly user_id: number;
}

export interface ReadyPayload {
  readonly capabilities?: {
    readonly message_deduplication?: boolean;
    readonly message_retry_window_seconds?: number;
    readonly message_retry_floor_ms?: number;
    /**
     * The server keeps a read pointer: `channel_focus` may skip marking read,
     * `mark_read` may carry a `message_id`, and `mark_unread` and `read_state`
     * exist. Absent means an older server.
     */
    readonly read_pointer?: boolean;
    /**
     * The server keeps private per-member profile notes, read and
     * written over `/users/me/notes/{userId}`. Absent means an older server.
     */
    readonly user_notes?: boolean;
    /**
     * The server keeps a profile banner, an image and/or a colour:
     * `POST` and `DELETE` `/users/me/banner`, `banner_color` on `PATCH
     * /users/me`. Advertised even when attachment storage is off, in which case
     * the upload route is not mounted. Absent means an older server.
     */
    readonly profile_banners?: boolean;
    /**
     * The server understands `poll_create`, `poll_vote` and `poll_end` and sends
     * `poll_update`. Absent means an older server: no Poll button.
     */
    readonly polls?: boolean;
    /**
     * The server has custom stickers: `sticker_id` on `chat_send`,
     * `sticker` on `chat_message`, `sticker_update` and `/api/v1/stickers`.
     * Absent means an older server: no sticker button.
     */
    readonly stickers?: boolean;
    /**
     * The server stores the caller's two direct message privacy settings,
     * read and written over `/users/me/privacy`. Absent means an older
     * server.
     */
    readonly dm_privacy?: boolean;
    /**
     * The server supports threads: the `thread_*` frames and `GET
     * /channels/{id}/threads`. Absent means an older server, which shows no
     * thread controls.
     */
    readonly threads?: boolean;
    /**
     * The server supports forum channels: `forum_post_create` and a
     * forum's posts. Absent means an older server, which offers no Forum type.
     */
    readonly forums?: boolean;
    /**
     * A member can hold several roles: `role_ids` rides `members[]`,
     * `auth_ok.user`, `member_join.user` and `member_update`, roles carry
     * `hoist`, and `PUT`/`DELETE {base}/{id}/roles/{roleId}` add and remove
     * one. Absent means an older server, where `role` is the only role.
     */
    readonly multi_role?: boolean;
    /**
     * A moderator holding MANAGE_NICKNAMES can set another member's nickname
     * over `PUT /moderation/users/{id}/nickname`. Absent means an
     * older server, where the bit may exist but the route does not.
     */
    readonly manage_nicknames?: boolean;
    /**
     * Content may carry `<@id>` and `<@&id>` mention tokens: the
     * composer sends the ones the user picked, the server resolves them and
     * lists honoured roles in `mention_roles`. Absent means an older server,
     * where a mention is the plain `@name` text.
     */
    readonly id_mentions?: boolean;
    /**
     * The server understands `thread_follow`, sends `thread_follow_update` and
     * lists the viewer's followed threads in `ready.threads`. Absent
     * means an older server: no Follow control, no followed threads.
     */
    readonly thread_follows?: boolean;
    /**
     * The server accepts `voice_duration_ms` and `voice_waveform` on an upload
     * and returns `duration_ms` and `waveform` on the attachment.
     * Absent means an older server: no mic button in the composer.
     */
    readonly voice_messages?: boolean;
    /**
     * The server understands `activity_update` and carries a member's game as
     * `activity` on `presence` and `presence_batch` and as `ready.activities`.
     * Absent means an older server: nothing is sent, no game shown.
     */
    readonly game_activity?: boolean;
    /**
     * The server understands `listening_update` and carries a member's song as
     * `listening` on `presence` and `presence_batch` and as `ready.listening`.
     * Absent means an older server: nothing is sent, no song shown.
     */
    readonly listening_activity?: boolean;
  };
  /**
   * The songs connected members are listening to, sorted by user id.
   * Absent from a server without `listening_activity`; later changes arrive as
   * `presence`.
   */
  readonly listening?: readonly ReadyListening[];
  /**
   * The games connected members are playing, sorted by user id. Absent
   * from a server without `game_activity`; authoritative for the moment of the
   * snapshot, later changes arrive as `presence`.
   */
  readonly activities?: readonly ReadyActivity[];
  readonly channels: readonly ReadyChannel[];
  /**
   * The viewer's followed, open threads, newest activity first.
   * Present whenever the server advertises `thread_follows`; authoritative for
   * the set. Absent from older servers.
   */
  readonly threads?: readonly ReadyThread[];
  /**
   * The full category list, present only for a viewer holding MANAGE_CHANNELS.
   * Absent for everyone else and for older servers, which derive
   * their groups from the channels alone.
   */
  readonly categories?: readonly ChannelCategory[];
  readonly members: readonly ReadyMember[];
  readonly voice_states: readonly ReadyVoiceState[];
  readonly roles: readonly ReadyRole[];
  readonly dm_channels?: readonly DmChannelPayload[];
  /** The caller's unacknowledged warnings. Absent from older servers. */
  readonly notices?: readonly ReadyNotice[];
  /**
   * Active timeouts: the full list for a moderator, only the
   * caller's own entry for anyone else. Absent from older servers.
   */
  readonly member_timeouts?: readonly MemberTimeoutEntry[];
}

/** One active timeout: who, and until when (RFC 3339). Never the reason or actor. */
export interface MemberTimeoutEntry {
  readonly user_id: number;
  readonly expires_at: string;
}

/** member_timeouts: replaces the viewer's list wholesale. */
export interface MemberTimeoutsPayload {
  readonly timeouts: readonly MemberTimeoutEntry[];
}

/** One of ready's notices: never the actor or the report link (Server/ws/serve_ready.go). */
export interface ReadyNotice {
  readonly id: number;
  readonly kind: "warning";
  readonly reason: string;
  readonly created_at: string;
}

/**
 * mod_action: a warning or timeout applied to this user, targeted and
 * not replayed. A lifted timeout arrives as id 0, kind "timeout" and a null
 * expires_at (Server/ws/moderation_actions.go).
 */
export interface ModActionPayload {
  readonly id: number;
  readonly kind: "warning" | "timeout";
  readonly reason: string;
  readonly expires_at: string | null;
}

/**
 * appeal_status: the caller's own appeal changed state, targeted and
 * not replayed (Server/ws/appeal_status.go). decision_note is null until decided.
 */
export interface AppealStatusPayload {
  readonly id: string;
  readonly state: "assigned" | "upheld" | "overturned" | "withdrawn";
  readonly decision_note: string | null;
}

/**
 * mention_count: one reader's `read_states.mention_count` changed in a
 * channel. Targeted, unsequenced and never replayed. `count` is the reader's
 * total after the bump, so a client repaints the badge from it directly rather
 * than incrementing. This is how a mention in a channel the user is not viewing
 * reaches their sidebar/taskbar badge live.
 */
export interface MentionCountPayload {
  readonly channel_id: number;
  readonly count: number;
}

/**
 * channel_activity: an unread hint for readable channels the reader
 * is not viewing. Batched (about one frame a second), unsequenced and never
 * replayed. Per channel at most two entries in ascending `message_id`: the
 * latest message that mentioned the reader, then the latest overall.
 * `author_id` is omitted for a reader who has not acknowledged an
 * NSFW-labelled channel. `mention_count` stays the badge's authority.
 */
export interface ChannelActivityEntry {
  readonly channel_id: number;
  readonly message_id: number;
  readonly author_id?: number;
  readonly mentions_you: boolean;
  readonly mentions_everyone: boolean;
}

export interface ChannelActivityPayload {
  readonly channels: readonly ChannelActivityEntry[];
}

/**
 * mod_queue: a report or appeal queue changed, to MODERATE_MEMBERS
 * holders only, unsequenced and never replayed. Exactly one id is set; it is
 * an invalidation signal, never the report itself.
 */
export interface ModQueuePayload {
  readonly report_id?: string;
  readonly appeal_id?: string;
  readonly state: string;
}

/** Reply parent snippet. A deleted parent is redacted to `{id, deleted: true}`. */
export interface ReferencedMessage {
  readonly id: number;
  readonly user: MessageUser | null;
  readonly content: string;
  readonly deleted: boolean;
  readonly has_attachments: boolean;
}

/**
 * The call a `kind: "call"` row stands for. `ended_at` is null while
 * the call is live; `participants` is everyone who was ever in it.
 */
export interface CallInfo {
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly participants: readonly number[];
}

/**
 * The payload of a group DM system row, by `kind`: `target_user_id`
 * for group_add / group_remove, `name` for group_rename ("" = the name was
 * removed), `icon_removed` for group_icon, nothing for group_leave. The render
 * source for those rows; `content` is only an English fallback sentence.
 */
export interface GroupEventInfo {
  readonly target_user_id?: number;
  readonly name?: string;
  readonly icon_removed?: boolean;
}

/**
 * The snapshot link on a forwarded message. No author and no channel
 * name ride on it; `source_message_id` is null once the original is deleted or
 * purged, so the jump link is shown only while it is set.
 */
export interface ForwardInfo {
  readonly source_channel_id: number;
  readonly source_message_id: number | null;
  readonly source_timestamp: string;
}

/** One answer of a poll. `emoji` is a Unicode emoji or a `:shortcode:`, or null. */
export interface PollAnswer {
  readonly answer_id: number;
  readonly text: string;
  readonly emoji?: string | null;
}

export interface PollCount {
  readonly answer_id: number;
  readonly count: number;
}

/**
 * A poll's tally. `version` rises by one on every vote change and on the end,
 * and orders every copy of it; `me` is the viewer's own answer ids.
 */
export interface PollResults {
  readonly version: number;
  readonly total_voters: number;
  readonly counts: readonly PollCount[];
  readonly me: readonly number[];
}

/** The `poll` block of a poll message, live and in history. */
export interface PollInfo {
  readonly question: string;
  readonly answers: readonly PollAnswer[];
  readonly allow_multiselect: boolean;
  readonly expires_at: string;
  readonly ended: boolean;
  readonly ended_at: string | null;
  readonly results: PollResults;
}

/**
 * A poll as the client holds it: the wire block plus the version `results.me`
 * is current as of. `me` moves only from a frame whose version is above this,
 * which is the second watermark that keeps a viewer's own selection right when
 * their devices' frames arrive out of order.
 */
export interface PollView extends PollInfo {
  readonly selfVersion: number;
}

/** A poll's tally after a vote or its end; `user_id` and `answer_ids` ride only on a vote. */
export interface PollUpdatePayload {
  readonly channel_id: number;
  readonly message_id: number;
  readonly version: number;
  readonly total_voters: number;
  readonly counts: readonly PollCount[];
  readonly ended: boolean;
  readonly ended_at: string | null;
  readonly user_id?: number;
  readonly answer_ids?: readonly number[];
}

export interface PollCreateOkPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly client_message_id: string;
  readonly deduplicated: boolean;
}

export interface PollVoteOkPayload {
  readonly message_id: number;
  readonly version: number;
  readonly answer_ids: readonly number[];
}

export interface PollEndOkPayload {
  readonly message_id: number;
}

/**
 * A thread as the server states it. Always absolute: a later frame
 * replaces an earlier one. `owner_id` and `starter_message_id` are null once
 * the user or the message is erased; `last_message_at` is null with no replies.
 */
export interface ThreadInfo {
  readonly id: number;
  readonly parent_id: number;
  readonly name: string;
  readonly owner_id: number | null;
  readonly starter_message_id: number | null;
  readonly archived: boolean;
  readonly locked: boolean;
  readonly auto_archive_minutes: number;
  readonly message_count: number;
  readonly last_message_at: string | null;
  readonly created_at: string;
  /** Present only when the parent is a forum: the post's tags and opening message. */
  readonly post?: ForumPostMeta;
}

/** A forum post's tags and a preview of its opening message. */
export interface ForumPostMeta {
  readonly tag_ids: readonly number[];
  /** Null once the opening message is hard-deleted. */
  readonly first_message: ForumFirstMessage | null;
}

export interface ForumFirstMessage {
  readonly id: number;
  readonly author_id: number;
  /** The sanitised text cut to 200 characters; empty for a deleted message. */
  readonly preview: string;
  readonly has_attachments: boolean;
  readonly deleted: boolean;
}

/** One entry of `ready.threads`: a followed thread and the viewer's read state in it. */
export interface ReadyThread {
  readonly thread: ThreadInfo;
  readonly last_message_id: number;
  readonly last_read_message_id: number;
  readonly unread_count: number;
  readonly mention_count: number;
}

/** thread_follow_ok / thread_follow_update. `thread` rides a `following: true` update. */
export interface ThreadFollowPayload {
  readonly thread_id: number;
  readonly following: boolean;
  readonly thread?: ThreadInfo;
}

/** The idle periods a thread can auto-archive after, in minutes. */
export type ThreadAutoArchiveMinutes = 60 | 1440 | 4320 | 10080;

/** thread_create_ok / thread_changed: the thread's whole state. */
export interface ThreadPayload {
  readonly thread: ThreadInfo;
}

/** thread_deleted: `channel_id` is the parent. */
export interface ThreadDeletedPayload {
  readonly channel_id: number;
  readonly thread_id: number;
}

/** Start a thread on a message of a text channel. */
export interface ThreadCreatePayload {
  readonly channel_id: number;
  readonly message_id: number;
  readonly name: string;
  readonly auto_archive_minutes: ThreadAutoArchiveMinutes;
}

/** Change a thread; an absent field is unchanged. */
export interface ThreadUpdatePayload {
  readonly thread_id: number;
  readonly name?: string;
  readonly archived?: boolean;
  readonly locked?: boolean;
  readonly auto_archive_minutes?: ThreadAutoArchiveMinutes;
}

/** One file in a channel's media gallery and the message it was posted in. */
export interface ChannelMediaItem {
  readonly attachment: Attachment;
  readonly message_id: number;
  readonly user: { readonly id: number; readonly username: string; readonly avatar?: string };
  /** The message's send time, "YYYY-MM-DD HH:MM:SS" UTC. */
  readonly timestamp: string;
}

/** GET /channels/{id}/media. `next_cursor` is opaque and "" on the last page. */
export interface ChannelMediaPage {
  readonly items: readonly ChannelMediaItem[];
  readonly next_cursor: string;
}

/** GET /channels/{id}/media/months: newest month first, in the caller's zone. */
export interface ChannelMediaMonthsResponse {
  readonly months: readonly { readonly month: string; readonly count: number }[];
}

/** The gallery's filters; `kind` media is images and videos, files the rest. */
export interface ChannelMediaQuery {
  readonly kind: "media" | "files";
  readonly order?: "newest" | "oldest";
  /** File name contains. */
  readonly q?: string;
  /** Uploader user id. */
  readonly from?: number;
  /** "YYYY-MM": start the walk at that month. Ignored with `cursor`. */
  readonly month?: string;
  readonly tz?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** GET /channels/{id}/threads. `next_before` is opaque and "" on the last page. */
export interface ThreadListResponse {
  readonly threads: readonly ThreadInfo[];
  readonly has_more: boolean;
  readonly next_before: string;
}

export interface ChatMessagePayload {
  readonly client_message_id?: string;
  readonly id: number;
  readonly channel_id: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly reply_to: number | null;
  /** Parent snippet. Absent from older servers; null when not a reply. */
  readonly referenced_message?: ReferencedMessage | null;
  readonly attachments: readonly Attachment[];
  readonly timestamp: string;
  /**
   * Server-resolved user IDs this message mentions, ordered by first
   * appearance. Absent from older servers — callers fall back to resolving
   * @tokens against the member list. Never contains @everyone/@here.
   */
  readonly mentions?: readonly number[];
  /**
   * Role IDs this message mentions that resolved and cleared the sender's gate.
   * Authoritative when present; absent from older servers, where
   * the `<@&id>` tokens in `content` stand in.
   */
  readonly mention_roles?: readonly number[];
  /**
   * Whether an @everyone/@here in the content cleared the sender's
   * MENTION_EVERYONE gate. A token without the bit carries no mention
   * semantics at all. Absent from older servers.
   */
  readonly mentions_everyone?: boolean;
  /**
   * Whether the mentions_everyone bit above came from @here rather than
   * @everyone (never both — @here only narrows when @everyone is absent).
   * The server's applyMentionCounts (mentions.go) skips the mention-count
   * bump for an @here fan-out reader with no live connection at send time;
   * the client uses this bit to avoid raising a badge a reconnect replay
   * cannot otherwise correct. Absent from older servers.
   */
  readonly mentions_here?: boolean;
  /** `ChatMessageKind` value ("call" for a DM call log row), open to future kinds; absent for an ordinary message (and from older servers). */
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

export interface ChatSendOkPayload {
  readonly client_message_id?: string;
  readonly deduplicated?: boolean;
  readonly message_id: number;
  readonly timestamp: string;
  /** Requested uploads the server did not attach (2A-3); absent from older servers. */
  readonly skipped_attachment_ids?: readonly string[];
}

/** The reply to `chat_forward`: `message_id` is the new message in `channel_id` (the target). */
export interface ChatForwardOkPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly client_message_id: string;
  readonly deduplicated: boolean;
}

export interface ChatEditedPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly content: string;
  /** Null for the end of a call row, which is never shown as an edit. */
  readonly edited_at: string | null;
  /** Re-resolved mentions for the new content. An edit never re-notifies. */
  readonly mentions?: readonly number[];
  /** See ChatMessagePayload.mention_roles. */
  readonly mention_roles?: readonly number[];
  readonly mentions_everyone?: boolean;
  /** See ChatMessagePayload.mentions_here. */
  readonly mentions_here?: boolean;
  readonly kind?: string;
  readonly call?: CallInfo;
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

export interface ChatPinnedPayload {
  readonly message_id: number;
  readonly channel_id: number;
  readonly pinned: boolean;
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
  /** The game the user is playing. Always present on a server with
   *  `game_activity` (null = none); absent from an older one, where the store
   *  leaves the shown game alone. */
  readonly activity?: GameActivity | null;
  /** The song the user is listening to. Always present on a server
   *  with `listening_activity` (null = none); absent from an older one. */
  readonly listening?: ListeningActivity | null;
}

export interface ChannelCreatePayload {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  /** See ReadyChannel.category_id. */
  readonly category_id?: number;
  /** See ReadyChannel.category_position. */
  readonly category_position?: number;
  readonly topic?: string;
  /** See ReadyChannel.forum. */
  readonly forum?: ForumSettings;
  readonly position: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — the age-restriction label the server enforces. */
  readonly nsfw?: boolean;
  /** See ReadyChannel.private — absent means unchanged. */
  readonly private?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /** See ReadyChannel.password_protected — absent means unchanged. */
  readonly password_protected?: boolean;
  /** See ReadyChannel.afk — absent means unchanged. */
  readonly afk?: boolean;
  /**
   * This viewer's composer affordance — see ReadyChannel.can_send.
   *
   * Every channel_create is addressed to one client — at channel creation
   * and when a role or override edit changes who may post
   * (RefreshChannelVisibility) — and carries this viewer's verdict. Older
   * servers sent a shared broadcast without it. Treat absent as "unchanged",
   * never as false.
   */
  readonly can_send?: boolean;
  /**
   * This viewer's voice-moderation affordance — see
   * ReadyChannel.can_moderate_voice. Same targeted-only, absent-means-
   * unchanged rules as can_send.
   */
  readonly can_moderate_voice?: boolean;
  /** This viewer's move affordance — see ReadyChannel.can_move_voice. Absent means unchanged. */
  readonly can_move_voice?: boolean;
  /** This viewer's message affordances — see ReadyChannel. Absent means unchanged. */
  readonly can_delete_others?: boolean;
  readonly can_pin?: boolean;
  readonly can_react?: boolean;
}

export interface ChannelUpdatePayload {
  readonly id: number;
  readonly name?: string;
  readonly topic?: string;
  /** See ReadyChannel.forum — absent means unchanged. */
  readonly forum?: ForumSettings;
  /**
   * The category the channel now sits under ("" = uncategorized). Moving a
   * channel between categories is an edit, so the broadcast carries it and
   * the sidebar regroups without a reconnect.
   */
  readonly category?: string | null;
  /** See ReadyChannel.category_id — absent means unchanged. */
  readonly category_id?: number;
  /** See ReadyChannel.category_position — absent means unchanged. */
  readonly category_position?: number;
  readonly position?: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — the age-restriction label the server enforces. */
  readonly nsfw?: boolean;
  /** See ReadyChannel.private — absent means unchanged. */
  readonly private?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /** See ReadyChannel.password_protected — absent means unchanged. */
  readonly password_protected?: boolean;
  /** See ReadyChannel.afk — absent means unchanged. */
  readonly afk?: boolean;
}

/** nsfw_ack — the caller acknowledged or revoked a labelled channel on another device. */
export interface NsfwAckPayload {
  readonly channel_id: number;
  readonly acknowledged: boolean;
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

/** Server -> Client: the server moved this client to another voice channel,
 *  by a moderator (no `reason`) or the AFK sweep (`reason: "afk"`). */
export interface VoiceMovedPayload {
  readonly to_channel_id: number;
  readonly reason?: "afk";
  /** The moderator who made the move; absent for the AFK sweep and on older servers. */
  readonly by_user_id?: number;
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

/** Argument shape for `voice.store.setSpeakers` — fed by LiveKit's
 *  ActiveSpeakersChanged, not by a wire message.
 *  CRITICAL: uses threshold_mode, NOT mode. */
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

/**
 * `game_activity_policy` — an admin turned game activity on or off for the
 * server. Unsequenced and not replayed; `auth_ok` carries the same
 * value on every connect and resume.
 */
export interface GameActivityPolicyPayload {
  readonly enabled: boolean;
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
  /**
   * The group's owner (user id). Groups only, and only from a server with
   * group DM member management; its absence on a group means member management is unavailable.
   */
  readonly owner_id?: number;
  /**
   * The group's icon: "/api/v1/files/{id}", or "" for none. Absent from a
   * server without group icons; absent and "" both mean no icon.
   */
  readonly icon?: string;
  readonly last_message_id: number | null;
  readonly last_message: string;
  readonly last_message_at: string;
  readonly unread_count: number;
  /**
   * Unread messages in this DM that mention the current user. Absent from
   * older servers, which shipped no DM mention state at all — treat as 0.
   */
  readonly mention_count?: number;
  /**
   * The caller's read pointer in this DM (see ReadyChannel). Only the ready and
   * GET /dms entries carry it; dm_channel_open frames omit it.
   */
  readonly last_read_message_id?: number;
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

// -----------------------------------------------------------------------------
// Client → Server Payloads
// -----------------------------------------------------------------------------

export interface AuthPayload {
  readonly token: string;
  readonly last_seq?: number;
  /** The wire epoch this client speaks — always `PROTOCOL_EPOCH`. */
  readonly epoch: number;
  /**
   * The channel this client had open when it disconnected, sent only on a
   * resume (`last_seq > 0`).
   *
   * Lets the server restore the ChannelTopic subscription during the handshake
   * instead of leaving the socket unsubscribed until the post-`auth_ok`
   * `channel_focus` round trip lands — messages broadcast in that window would
   * otherwise reach nobody on this connection and could never be re-requested,
   * since the client only reports `max(seq)`. The server re-checks read
   * permission before honouring it. Omitted when unknown.
   */
  readonly active_channel_id?: number;
  /**
   * What this client can render, declared once per connection. The
   * server withholds anything not declared, so an older client never sees it.
   */
  readonly features?: readonly string[];
  /**
   * This device's identity public key (base64, the format PATCH /users/me
   * takes). The server attaches it to the voice E2EE announces this connection
   * sends, so peers verify against the announcing device's own key. Omitted
   * when the key is unavailable or for an older client.
   */
  readonly identity_public_key?: string;
}

export interface ChatSendPayload {
  readonly client_message_id?: string;
  readonly channel_id: number;
  readonly content: string;
  readonly reply_to: number | null;
  /** With reply_to, whether the reply mentions the parent's author (3A-12). */
  readonly reply_ping?: boolean;
  readonly attachments: readonly string[];
  /** Sends a custom sticker: needs `client_message_id`, no text, no attachments. */
  readonly sticker_id?: number;
}

/** Create a forum post and its opening message in one step. */
export interface ForumPostCreatePayload {
  readonly channel_id: number;
  readonly name: string;
  readonly content: string;
  readonly attachments: readonly string[];
  readonly tag_ids: readonly number[];
  readonly client_message_id: string;
}

/** forum_post_create_ok: `thread` is absent on a deduplicated answer to a caller who lost the forum. */
export interface ForumPostCreateOkPayload {
  readonly thread?: ThreadInfo;
  readonly message_id: number;
  readonly client_message_id?: string;
  readonly deduplicated?: boolean;
  readonly skipped_attachment_ids?: readonly string[];
}

/** Copy one message into one channel or DM; `client_message_id` is required. */
export interface ChatForwardPayload {
  readonly client_message_id: string;
  readonly channel_id: number;
  readonly message_id: number;
}

/** One answer of a new poll; `emoji` is optional. */
export interface PollCreateAnswer {
  readonly text: string;
  readonly emoji?: string;
}

/** Post a poll as a message; `client_message_id` is required. */
export interface PollCreatePayload {
  readonly client_message_id: string;
  readonly channel_id: number;
  readonly question: string;
  readonly answers: readonly PollCreateAnswer[];
  readonly duration_hours: number;
  readonly allow_multiselect: boolean;
}

/** Set the sender's whole selection on a poll; `[]` removes the vote. */
export interface PollVotePayload {
  readonly message_id: number;
  readonly answer_ids: readonly number[];
}

export interface PollEndPayload {
  readonly message_id: number;
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
  /**
   * false = focus and subscribe without marking the channel read (only with
   * the `read_pointer` capability). Absent means true, as for older clients.
   */
  readonly read?: boolean;
}

/**
 * mark_read — advance the read state for a channel the user is *not* viewing.
 * Same shape as channel_focus, deliberately a different message: focus also
 * rebinds the connection's focused channel, which would be wrong here.
 */
export interface MarkReadPayload {
  readonly channel_id: number;
  /**
   * Read up to this message (forward only, only with the `read_pointer`
   * capability). Absent marks the channel read at its latest message.
   */
  readonly message_id?: number;
}

/**
 * mark_unread — move the read pointer to just before `message_id`, so that
 * message and everything after it is unread again (`read_pointer` capability).
 */
export interface MarkUnreadPayload {
  readonly channel_id: number;
  readonly message_id: number;
}

/**
 * read_state — the caller's read pointer for one channel or DM after a
 * `mark_read` or `mark_unread` was accepted. Targeted, unsequenced and never
 * replayed; replaces the pointer and both counts outright.
 */
export interface ReadStatePayload {
  readonly channel_id: number;
  readonly last_read_message_id: number;
  readonly unread_count: number;
  readonly mention_count: number;
}

export interface PresenceUpdatePayload {
  readonly status: UserStatus;
  /** Omitted = leave the stored text alone (what the auto-idle timer sends);
   *  "" = clear it. */
  readonly custom_status?: string;
  /** Whole seconds (60..604800) after which the server clears the custom
   *  status. Only valid with a non-empty `custom_status`; omitted = no expiry. */
  readonly custom_status_expires_in?: number;
}

/** Client→Server: the game being played, or null once it stops. */
export interface ActivityUpdatePayload {
  readonly activity: GameActivity | null;
}

/** Client→Server: the song being listened to, or null once it stops. */
export interface ListeningUpdatePayload {
  readonly listening: ListeningActivity | null;
}

export interface VoiceJoinPayload {
  readonly channel_id: number;
  /** Set on the user's own join; automatic rejoins (reconnect, voice_moved) omit it. */
  readonly user_initiated?: boolean;
  /** The channel's password, sent once by the user for a protected channel; never stored. */
  readonly password?: string;
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
  | (WsEnvelope<ChatForwardOkPayload> & { readonly type: "chat_forward_ok" })
  | (WsEnvelope<ThreadPayload> & { readonly type: "thread_create_ok" })
  | (WsEnvelope<ForumPostCreateOkPayload> & { readonly type: "forum_post_create_ok" })
  | (WsEnvelope<{ readonly thread_id: number }> & { readonly type: "thread_update_ok" })
  | (WsEnvelope<ThreadPayload> & { readonly type: "thread_changed" })
  | (WsEnvelope<ThreadDeletedPayload> & { readonly type: "thread_deleted" })
  | (WsEnvelope<ThreadFollowPayload> & { readonly type: "thread_follow_ok" })
  | (WsEnvelope<ThreadFollowPayload> & { readonly type: "thread_follow_update" })
  | (WsEnvelope<ChatEditedPayload> & { readonly type: "chat_edited" })
  | (WsEnvelope<ChatDeletedPayload> & { readonly type: "chat_deleted" })
  | (WsEnvelope<ChatBulkDeletedPayload> & { readonly type: "chat_bulk_deleted" })
  | (WsEnvelope<ChatPinnedPayload> & { readonly type: "chat_pinned" })
  | (WsEnvelope<ReactionUpdatePayload> & { readonly type: "reaction_update" })
  | (WsEnvelope<PollUpdatePayload> & { readonly type: "poll_update" })
  | (WsEnvelope<PollCreateOkPayload> & { readonly type: "poll_create_ok" })
  | (WsEnvelope<PollVoteOkPayload> & { readonly type: "poll_vote_ok" })
  | (WsEnvelope<PollEndOkPayload> & { readonly type: "poll_end_ok" })
  | (WsEnvelope<TypingPayload> & { readonly type: "typing" })
  | (WsEnvelope<PresencePayload> & { readonly type: "presence" })
  | (WsEnvelope<PresenceBatchPayload> & { readonly type: "presence_batch" })
  | (WsEnvelope<ChannelCreatePayload> & { readonly type: "channel_create" })
  | (WsEnvelope<ChannelUpdatePayload> & { readonly type: "channel_update" })
  | (WsEnvelope<ChannelCategoriesPayload> & { readonly type: "channel_categories" })
  | (WsEnvelope<ChannelDeletePayload> & { readonly type: "channel_delete" })
  | (WsEnvelope<NsfwAckPayload> & { readonly type: "nsfw_ack" })
  | (WsEnvelope<VoiceStatePayload> & { readonly type: "voice_state" })
  | (WsEnvelope<VoiceLeavePayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceConfigPayload> & { readonly type: "voice_config" })
  | (WsEnvelope<VoiceTokenPayload> & { readonly type: "voice_token" })
  | (WsEnvelope<VoiceMovedPayload> & { readonly type: "voice_moved" })
  | (WsEnvelope<VoiceDisconnectedPayload> & { readonly type: "voice_disconnected" })
  | (WsEnvelope<VoiceE2EEAnnouncePayload> & { readonly type: "voice_e2ee_announce" })
  | (WsEnvelope<VoiceE2EEOfferPayload> & { readonly type: "voice_e2ee_offer" })
  | (WsEnvelope<VoiceWatchingPayload> & { readonly type: "voice_watching" })
  | (WsEnvelope<MemberJoinPayload> & { readonly type: "member_join" })
  | (WsEnvelope<MemberUpdatePayload> & { readonly type: "member_update" })
  | (WsEnvelope<UserUpdatePayload> & { readonly type: "user_update" })
  | (WsEnvelope<MemberBanPayload> & { readonly type: "member_ban" })
  | (WsEnvelope<ModActionPayload> & { readonly type: "mod_action" })
  | (WsEnvelope<AppealStatusPayload> & { readonly type: "appeal_status" })
  | (WsEnvelope<MentionCountPayload> & { readonly type: "mention_count" })
  | (WsEnvelope<ReadStatePayload> & { readonly type: "read_state" })
  | (WsEnvelope<ChannelActivityPayload> & { readonly type: "channel_activity" })
  | (WsEnvelope<ModQueuePayload> & { readonly type: "mod_queue" })
  | (WsEnvelope<MemberTimeoutsPayload> & { readonly type: "member_timeouts" })
  | (WsEnvelope<RolesUpdatePayload> & { readonly type: "roles_update" })
  | (WsEnvelope<EmojiUpdatePayload> & { readonly type: "emoji_update" })
  | (WsEnvelope<StickerUpdatePayload> & { readonly type: "sticker_update" })
  | (WsEnvelope<UploadPolicyPayload> & { readonly type: "upload_policy" })
  | (WsEnvelope<GameActivityPolicyPayload> & { readonly type: "game_activity_policy" })
  | (WsEnvelope<DmChannelOpenPayload> & { readonly type: "dm_channel_open" })
  | (WsEnvelope<DmChannelClosePayload> & { readonly type: "dm_channel_close" })
  | (WsEnvelope<DmRequestPayload> & { readonly type: "dm_request" })
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
  | (WsEnvelope<ChatForwardPayload> & { readonly type: "chat_forward" })
  | (WsEnvelope<PollCreatePayload> & { readonly type: "poll_create" })
  | (WsEnvelope<PollVotePayload> & { readonly type: "poll_vote" })
  | (WsEnvelope<PollEndPayload> & { readonly type: "poll_end" })
  | (WsEnvelope<ThreadCreatePayload> & { readonly type: "thread_create" })
  | (WsEnvelope<ForumPostCreatePayload> & { readonly type: "forum_post_create" })
  | (WsEnvelope<ThreadUpdatePayload> & { readonly type: "thread_update" })
  | (WsEnvelope<{ readonly thread_id: number }> & { readonly type: "thread_delete" })
  | (WsEnvelope<{ readonly thread_id: number | null }> & { readonly type: "thread_focus" })
  | (WsEnvelope<{ readonly thread_id: number; readonly follow: boolean }> & {
      readonly type: "thread_follow";
    })
  | (WsEnvelope<ChatEditPayload> & { readonly type: "chat_edit" })
  | (WsEnvelope<ChatDeletePayload> & { readonly type: "chat_delete" })
  | (WsEnvelope<ReactionAddPayload> & { readonly type: "reaction_add" })
  | (WsEnvelope<ReactionRemovePayload> & { readonly type: "reaction_remove" })
  | (WsEnvelope<TypingStartPayload> & { readonly type: "typing_start" })
  | (WsEnvelope<ChannelFocusPayload> & { readonly type: "channel_focus" })
  | (WsEnvelope<MarkReadPayload> & { readonly type: "mark_read" })
  | (WsEnvelope<MarkUnreadPayload> & { readonly type: "mark_unread" })
  | (WsEnvelope<PresenceUpdatePayload> & { readonly type: "presence_update" })
  | (WsEnvelope<ActivityUpdatePayload> & { readonly type: "activity_update" })
  | (WsEnvelope<ListeningUpdatePayload> & { readonly type: "listening_update" })
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
  | (WsEnvelope<{
      public_key: string;
      signature?: string;
      /** This device's identity public key (the one that signed `signature`). */
      identity_public_key?: string;
      video_decode?: readonly string[];
    }> & {
      readonly type: "voice_e2ee_announce";
    })
  | (WsEnvelope<{ target_user_id: number; encrypted_key: string; iv: string }> & {
      readonly type: "voice_e2ee_offer";
    })
  | (WsEnvelope<{ user_ids: readonly number[] }> & { readonly type: "voice_watch" })
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
