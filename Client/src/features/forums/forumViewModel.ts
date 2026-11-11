/**
 * Forum view helpers that need no view state: the layout labels, the paging
 * section shape and the post sort key.
 */

import type { ThreadInfo } from "@lib/types";
import { activityMs, type ForumLayout, type ForumSort } from "./forumModel";

export const LAYOUT_LABEL = {
  grid: "layout.grid",
  list: "layout.list",
  split: "layout.split",
  feed: "layout.feed",
} as const satisfies Record<ForumLayout, string>;

/** One half of the list (open or archived) and how far it has been paged. */
export interface Section {
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  /** At least one page of it has landed. */
  started: boolean;
}

export const freshSection = (): Section => ({
  cursor: "",
  hasMore: true,
  loading: false,
  failed: false,
  started: false,
});

/** The number a post is ranked by under `sort`. */
export function sortKey(post: ThreadInfo, sort: ForumSort): number {
  return sort === "created" ? post.id : activityMs(post);
}
