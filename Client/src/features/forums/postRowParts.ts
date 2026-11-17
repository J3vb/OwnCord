/**
 * Small pieces of a forum post row, kept out of ForumView.ts: who wrote a
 * post, its preview line, and putting a list's rows in order in place.
 */

import { resolveDisplayName } from "@lib/ui/avatar";
import { previewMentionsToNames } from "@lib/text/mentionNames";
import type { ThreadInfo } from "@lib/types";
import { membersStore } from "@stores/members.store";
import { forumsText } from "../../i18n/forums";

export function authorOf(post: ThreadInfo) {
  const id = post.owner_id ?? post.post?.first_message?.author_id ?? null;
  return id === null ? undefined : membersStore.getState().members.get(id);
}

export function authorName(post: ThreadInfo): string {
  const member = authorOf(post);
  return member === undefined ? forumsText("post.unknownAuthor") : resolveDisplayName(member);
}

export function previewOf(post: ThreadInfo): { text: string; muted: boolean } {
  const first = post.post?.first_message ?? null;
  if (first === null || first.deleted) return { text: forumsText("post.deleted"), muted: true };
  if (first.preview !== "") return { text: previewMentionsToNames(first.preview), muted: false };
  return first.has_attachments
    ? { text: forumsText("post.attachment"), muted: true }
    : { text: "", muted: true };
}

/** Put `els` in `ul` in order, moving only what is out of place. */
export function syncChildren(ul: HTMLElement, els: readonly HTMLElement[]): void {
  els.forEach((el, i) => {
    if (ul.children[i] !== el) ul.insertBefore(el, ul.children[i] ?? null);
  });
  while (ul.children.length > els.length) ul.lastElementChild?.remove();
}
