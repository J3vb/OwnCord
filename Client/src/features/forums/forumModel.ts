/**
 * What a forum's post list decides without touching the DOM or a store (WP
 * 6.9d): the list route's query, which posts a tag filter keeps, and the order
 * the list shows them in. The order must agree with the server's, because the
 * view merges live `thread_changed` frames into the pages it fetched and sorts
 * the union again locally.
 */

import type { ThreadInfo } from "@lib/types";

export type ForumSort = "activity" | "created";

/** How the post list is drawn; the reader picks one and it is remembered. */
export type ForumLayout = "grid" | "list" | "split" | "feed";
export const FORUM_LAYOUTS: readonly ForumLayout[] = ["grid", "list", "split", "feed"];
export const FORUM_LAYOUT_PREF = "forumLayout";
/** Whether a forum's guidelines start open; the reader's last choice. */
export const FORUM_GUIDELINES_PREF = "forumGuidelinesOpen";

/** A stored layout, or the default for anything else. */
export function parseForumLayout(value: unknown): ForumLayout {
  return FORUM_LAYOUTS.find((l) => l === value) ?? "grid";
}

/** Posts per page: the server's default for a forum, spelled out. */
export const POST_PAGE_SIZE = 25;
/** The server refuses more than five `tag` filters in one request. */
export const MAX_TAG_FILTERS = 5;
/** The server accepts at most five tags on a post. */
export const MAX_POST_TAGS = 5;
/** The server's limit on a post title, in characters. */
export const POST_TITLE_MAX = 100;

export interface PostQuery {
  readonly sort: ForumSort;
  /** Any-of: each id becomes one `tag=` parameter. */
  readonly tags: readonly number[];
  readonly archived: boolean;
  /** The previous page's `next_before`; "" for the first page. */
  readonly cursor: string;
}

/** The query string for `GET /channels/{id}/threads` on a forum. */
export function postListQuery(q: PostQuery): string {
  const params = new URLSearchParams({
    archived: q.archived ? "1" : "0",
    sort: q.sort,
    limit: String(POST_PAGE_SIZE),
  });
  for (const id of q.tags) params.append("tag", String(id));
  if (q.cursor !== "") params.set("before", q.cursor);
  return params.toString();
}

/** When the post last saw activity, in ms; its creation time before any reply. */
export function activityMs(post: ThreadInfo): number {
  const at = Date.parse(post.last_message_at ?? post.created_at);
  return Number.isNaN(at) ? 0 : at;
}

/** Whether the post carries any selected tag; every post passes with none selected. */
export function matchesTags(post: ThreadInfo, selected: ReadonlySet<number>): boolean {
  if (selected.size === 0) return true;
  return post.post?.tag_ids.some((id) => selected.has(id)) === true;
}

/** `posts` newest first: by last activity, or by id for "Newest" (ids only grow). */
export function sortPosts(posts: readonly ThreadInfo[], sort: ForumSort): ThreadInfo[] {
  return posts.toSorted((a, b) =>
    sort === "created" ? b.id - a.id : activityMs(b) - activityMs(a) || b.id - a.id,
  );
}

/** Replies are every message but the opening one. */
export function replyCount(post: ThreadInfo): number {
  return Math.max(0, post.message_count - 1);
}

/** The title as the server will take it: trimmed, 1..100 characters, or null. */
export function cleanPostTitle(raw: string): string | null {
  const title = raw.trim();
  const length = Array.from(title).length;
  return length >= 1 && length <= POST_TITLE_MAX ? title : null;
}
