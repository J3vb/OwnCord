// Server to client WebSocket payloads and REST replies for threads, forum posts,
// channel media and uploads.

import type { Attachment, ThreadAutoArchiveMinutes } from "./wireCommon";

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
  /** Null when the author row is gone. */
  readonly author_id: number | null;
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
