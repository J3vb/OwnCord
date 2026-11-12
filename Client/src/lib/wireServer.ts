// Server to client WebSocket payloads.

import type { WsErrorCode } from "./protocolTypes";
import type {
  ReadyChannel,
  ReadyMember,
  ReadyRole,
  ReadyVoiceState,
  UserWithRole,
} from "./wireCommon";
import type { ReadyThread } from "./wireServerThreads";
import type {
  GameActivityPolicyPayload,
  VideoBitrateCapPayload,
  DmChannelPayload,
  GameActivity,
  ListeningActivity,
} from "./wireServerChannels";

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
  /** The video upload cap per person, sent on every connect and resume; absent on older servers. */
  readonly video_bitrate_cap?: VideoBitrateCapPayload;
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
  /** How long the server keeps an upload no message names; absent on older servers. */
  readonly staged_lifetime_seconds?: number;
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

/** One entry of `ready.activities`. */
export interface ReadyActivity extends GameActivity {
  readonly user_id: number;
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
    /**
     * The server answers `GET /channels/{id}/media` and `/media/months`.
     * Absent means an older server: no media gallery.
     */
    readonly channel_media?: boolean;
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
  /**
   * The server's clock (Unix ms) when it built this ready. The client stamps
   * `client_message_id` from it, so a device clock that runs fast or slow
   * does not lock it out of sending. Absent from older servers.
   */
  readonly server_time_ms?: number;
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

export type {
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
  ChatMessagePayload,
  ChatSendOkPayload,
  ChatForwardOkPayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ChatBulkDeletedPayload,
  ChatPinnedPayload,
  ReactionUpdatePayload,
} from "./wireServerMessages";
export type {
  ThreadInfo,
  ReadyThread,
  ThreadFollowPayload,
  ThreadPayload,
  ThreadDeletedPayload,
  ThreadCreatePayload,
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
} from "./wireServerThreads";
export type {
  TypingPayload,
  PresencePayload,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  NsfwAckPayload,
  ChannelDeletePayload,
  VoiceStatePayload,
  VoiceMovedPayload,
  VoiceDisconnectedPayload,
  VoiceLeavePayload,
  VoiceConfigPayload,
  VoiceSpeakersPayload,
  VoiceTokenPayload,
  GameActivityPolicyPayload,
  VideoBitrateCapPayload,
  DmRecipient,
  DmChannelPayload,
  GameActivity,
  ListeningActivity,
} from "./wireServerChannels";
