// Server to client WebSocket payloads.

import type { WsErrorCode } from "./protocolTypes";
import type {
  Attachment,
  ChannelType,
  ForumSettings,
  MessageStickerInfo,
  MessageUser,
  ReactionAction,
  ReadyChannel,
  ReadyMember,
  ReadyRole,
  ReadyVoiceState,
  ThreadAutoArchiveMinutes,
  UserStatus,
  UserWithRole,
  VoiceQuality,
} from "./wireCommon";

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

/**
 * Who wrote a message imported from a Discord export. Imported messages share
 * one hidden account, so this replaces `user` wherever a name is shown. `color`
 * is the export's role colour, untrusted: use it only as a `#rrggbb` hex.
 */
export interface ImportedAuthor {
  readonly name: string;
  readonly color?: string;
}

/** Reply parent snippet. A deleted parent is redacted to `{id, deleted: true}`. */
export interface ReferencedMessage {
  readonly id: number;
  readonly user: MessageUser | null;
  readonly content: string;
  readonly deleted: boolean;
  readonly has_attachments: boolean;
  /** Present when the parent is an imported message. */
  readonly imported_author?: ImportedAuthor;
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

/** GET /users/me/storage: the caller's upload usage; `quota_bytes` 0 means no limit. */
export interface UserStorage {
  readonly used_bytes: number;
  readonly quota_bytes: number;
}

/** Where one of the caller's uploads lives; only the first three can be removed. */
export type UserUploadState =
  "message" | "deleted" | "pending" | "avatar" | "banner" | "group_icon";

/** One of the caller's uploaded files and what holds it. */
export interface UserUploadItem {
  readonly attachment: Attachment;
  /** Upload time, "YYYY-MM-DD HH:MM:SS" UTC. */
  readonly uploaded_at: string;
  readonly channel_id: number | null;
  readonly message_id: number | null;
  readonly state: UserUploadState;
  readonly removable: boolean;
}

/** GET /users/me/uploads. `next_cursor` is opaque and omitted on the last page. */
export interface UserUploadsPage {
  readonly items: readonly UserUploadItem[];
  readonly next_cursor?: string;
}

export interface UserUploadsQuery {
  readonly sort?: "newest" | "largest";
  /** File name contains. */
  readonly q?: string;
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
  /**
   * The message's full remaining attachment list, `[]` when none are left.
   * Present when a file was removed from the message; absent on a text edit,
   * which leaves the attachments alone.
   */
  readonly attachments?: readonly Attachment[];
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

/**
 * `game_activity_policy` — an admin turned game activity on or off for the
 * server. Unsequenced and not replayed; `auth_ok` carries the same
 * value on every connect and resume.
 */
export interface GameActivityPolicyPayload {
  readonly enabled: boolean;
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
