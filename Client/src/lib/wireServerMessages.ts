// Server to client WebSocket payloads: messages, polls and chat frames.

import type { Attachment, MessageStickerInfo, MessageUser, ReactionAction } from "./wireCommon";
import type { ThreadInfo } from "./wireServerThreads";

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

/** One image of a link preview card: a thumbnail stored by the server, at most 640 px on a side. */
export interface LinkPreviewImage {
  readonly hash: string;
  readonly width: number;
  readonly height: number;
}

/** A link preview card the server built once for a message's link. */
export interface LinkPreviewCard {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly site_name?: string;
  readonly image?: LinkPreviewImage;
}

/** The whole set of cards a message now has; an empty list clears them. */
export interface MessageLinkPreviewsPayload {
  readonly message_id: number;
  readonly channel_id: number;
  /** The message's edited_at, else its timestamp: a frame older than the cards held is dropped. */
  readonly content_version: string;
  readonly link_previews: readonly LinkPreviewCard[];
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
