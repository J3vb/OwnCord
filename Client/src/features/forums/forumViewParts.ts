/**
 * Builders for the forum view's DOM: the header, the list and one post row.
 * Each only creates elements; the view paints and wires them.
 */

import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { avatarInitial } from "@lib/ui/avatar";
import type { ForumTag, ThreadInfo } from "@lib/types";
import { forumsText } from "../../i18n/forums";
import type { ForumViewContext } from "../navigation/destinations";
import {
  FORUM_LAYOUTS,
  MAX_TAG_FILTERS,
  replyCount,
  type ForumLayout,
  type ForumSort,
} from "./forumModel";
import { LAYOUT_LABEL, type Section } from "./forumViewModel";
import { authorOf, previewOf } from "./postRowParts";

/** The toolbar, guidelines banner and tag bar, empty until the view paints them. */
export function buildForumHeader(channelId: number) {
  const guidelines = createElement("section", {
    class: "forum-guidelines",
    "aria-label": forumsText("guidelines.title"),
    "data-testid": "forum-guidelines",
  });
  const guidelinesToggle = createElement("button", {
    type: "button",
    class: "forum-guidelines-toggle",
    "aria-expanded": "true",
    "aria-controls": `forum-guidelines-body-${channelId}`,
    "data-testid": "forum-guidelines-toggle",
  });
  const guidelinesBody = createElement("div", {
    id: `forum-guidelines-body-${channelId}`,
    class: "forum-guidelines-body",
    "data-testid": "forum-guidelines-body",
  });
  guidelines.append(guidelinesBody);

  const newPostBtn = createElement("button", {
    type: "button",
    class: "btn-primary forum-new-post",
    "data-testid": "forum-new-post",
  });
  newPostBtn.append(
    createIcon("pencil", 14),
    createElement("span", { class: "forum-new-post-label" }, forumsText("newPost")),
  );
  // The label folds away on a phone; the name stays for screen readers.
  newPostBtn.setAttribute("aria-label", forumsText("newPost"));

  const sortGroup = createElement("div", {
    class: "forum-sort",
    role: "group",
    "aria-label": forumsText("sort.label"),
  });
  const sortButtons = new Map<ForumSort, HTMLButtonElement>();
  for (const value of ["activity", "created"] as const) {
    const btn = createElement(
      "button",
      { type: "button", class: "forum-sort-btn", "data-testid": `forum-sort-${value}` },
      forumsText(value === "activity" ? "sort.activity" : "sort.created"),
    );
    sortButtons.set(value, btn);
    sortGroup.appendChild(btn);
  }
  const layoutGroup = createElement("div", {
    class: "forum-sort forum-layouts",
    role: "group",
    "aria-label": forumsText("layout.label"),
  });
  const layoutButtons = new Map<ForumLayout, HTMLButtonElement>();
  for (const value of FORUM_LAYOUTS) {
    const btn = createElement(
      "button",
      { type: "button", class: "forum-sort-btn", "data-testid": `forum-layout-${value}` },
      forumsText(LAYOUT_LABEL[value]),
    );
    layoutButtons.set(value, btn);
    layoutGroup.appendChild(btn);
  }
  const toolbar = createElement("div", { class: "forum-toolbar" });
  const spacer = createElement("span", { class: "forum-toolbar-spacer" });
  toolbar.append(guidelinesToggle, sortGroup, layoutGroup, spacer, newPostBtn);

  const tagBar = createElement("div", {
    class: "forum-tag-bar",
    role: "group",
    "aria-label": forumsText("tags.label"),
    "data-testid": "forum-tag-bar",
  });

  const header = createElement("div", { class: "forum-header" });
  header.append(toolbar, guidelines, tagBar);
  return {
    header,
    guidelines,
    guidelinesToggle,
    guidelinesBody,
    newPostBtn,
    sortButtons,
    layoutButtons,
    tagBar,
  };
}

/** The scrolling post lists with their empty, status, more and error lines. */
export function buildForumList() {
  const scroller = createElement("div", { class: "forum-scroller" });
  const openList = createElement("ul", {
    class: "forum-posts",
    "aria-label": forumsText("view.label"),
    "data-testid": "forum-posts",
  });
  const olderHead = createElement(
    "h3",
    { class: "forum-older-head", "data-testid": "forum-older-head" },
    forumsText("list.older"),
  );
  const olderList = createElement("ul", {
    class: "forum-posts forum-posts-older",
    "aria-label": forumsText("list.older"),
    "data-testid": "forum-posts-older",
  });
  const emptyEl = createElement("div", { class: "forum-empty", "data-testid": "forum-empty" });
  const emptyTitle = createElement("p", { class: "forum-empty-title" });
  const emptyHint = createElement("p", { class: "forum-empty-hint" });
  emptyEl.append(emptyTitle, emptyHint);
  const statusEl = createElement("div", {
    class: "forum-status",
    role: "status",
    "data-testid": "forum-status",
  });
  const moreBtn = createElement("button", {
    type: "button",
    class: "forum-more",
    "data-testid": "forum-more",
  });
  const errorEl = createElement("p", { class: "forum-error", role: "alert" });
  errorEl.hidden = true;
  const sentinel = createElement("div", { class: "forum-sentinel", "aria-hidden": "true" });
  scroller.append(openList, olderHead, olderList, emptyEl, statusEl, moreBtn, errorEl, sentinel);
  return {
    scroller,
    openList,
    olderHead,
    olderList,
    emptyEl,
    emptyTitle,
    emptyHint,
    statusEl,
    moreBtn,
    errorEl,
    sentinel,
  };
}

export function buildPostRow(
  ctx: ForumViewContext,
  signal: AbortSignal,
  post: ThreadInfo,
  labels: string[],
  author: string,
  ago: string,
): HTMLLIElement {
  const li = createElement("li", { class: "forum-post-item" });
  const btn = createElement("button", {
    type: "button",
    class: `forum-post${post.archived ? " archived" : ""}`,
    "data-post-id": String(post.id),
    "data-testid": `forum-post-${post.id}`,
  });
  const member = authorOf(post);
  const subject = member ?? { username: author };
  const avatar =
    ctx.avatar?.(subject, "forum-post-avatar") ??
    createElement("span", { class: "forum-post-avatar" }, avatarInitial(subject));
  const body = createElement("span", { class: "forum-post-body" });
  const head = createElement("span", { class: "forum-post-head" });
  head.appendChild(createElement("span", { class: "forum-post-title" }, post.name));
  if (post.locked) head.appendChild(createIcon("lock", 12));
  if (labels.length > 0) {
    const tags = createElement("span", { class: "forum-tags" });
    for (const label of labels)
      tags.appendChild(createElement("span", { class: "forum-tag" }, label));
    head.appendChild(tags);
  }
  const preview = previewOf(post);
  const previewEl = createElement(
    "span",
    { class: `forum-post-preview${preview.muted ? " muted" : ""}` },
    preview.text,
  );
  const replies = replyCount(post);
  const meta = createElement(
    "span",
    { class: "forum-post-meta" },
    [
      author,
      replies === 0 ? forumsText("post.noReplies") : forumsText("post.replies", { count: replies }),
      ago,
    ].join(" · "),
  );
  const stats = createElement("span", { class: "forum-post-stats", "aria-hidden": "true" });
  stats.append(
    createIcon("message-square", 14),
    createElement("span", { class: "forum-post-count" }, String(replies)),
  );
  body.append(head, previewEl, meta);
  btn.append(avatar, body, stats);
  btn.addEventListener("click", () => ctx.openPost(post.id), { signal });
  li.appendChild(btn);
  return li;
}

/** Rebuild the tag filter chips and the clear button, keeping focus on the
 *  chip that held it. */
export function paintTagBar(
  tagBar: HTMLElement,
  tags: readonly ForumTag[],
  selected: ReadonlySet<number>,
  signal: AbortSignal,
  onToggle: (tagId: number) => void,
  onClear: () => void,
): void {
  const full = selected.size >= MAX_TAG_FILTERS;
  const chips = tags.map((tag) => {
    const on = selected.has(tag.id);
    const chip = createElement(
      "button",
      {
        type: "button",
        class: `forum-tag forum-tag-chip${on ? " selected" : ""}`,
        "aria-pressed": String(on),
        "data-tag-id": String(tag.id),
        "data-testid": `forum-tag-${tag.id}`,
      },
      `${tag.emoji ?? ""} ${tag.name}`.trim(),
    );
    chip.disabled = full && !on;
    chip.addEventListener("click", () => onToggle(tag.id), { signal });
    return chip;
  });
  const clear = createElement(
    "button",
    { type: "button", class: "forum-tag-clear", "data-testid": "forum-tag-clear" },
    forumsText("tags.clear"),
  );
  clear.hidden = selected.size === 0;
  clear.addEventListener("click", () => onClear(), { signal });
  const focusedTag = document.activeElement?.getAttribute("data-tag-id");
  tagBar.replaceChildren(...chips, clear);
  if (focusedTag != null) {
    tagBar.querySelector<HTMLElement>(`[data-tag-id="${focusedTag}"]`)?.focus();
  }
}

/** Mark the post button for `current` (a post id as text) in `root`. */
export function markCurrentPost(root: HTMLElement, current: string): void {
  for (const btn of root.querySelectorAll<HTMLElement>("[data-post-id]")) {
    const on = btn.dataset["postId"] === current;
    btn.classList.toggle("current", on);
    if (on) btn.setAttribute("aria-current", "true");
    else btn.removeAttribute("aria-current");
  }
}

/** What a cached post row was built from; a changed signature rebuilds it. */
export function postRowSignature(
  post: ThreadInfo,
  previewText: string,
  labels: readonly string[],
  author: string,
  ago: string,
): string {
  return [
    post.name,
    post.archived,
    post.locked,
    post.message_count,
    previewText,
    labels.join("\u0000"),
    author,
    ago,
  ].join("|");
}

/** The "no posts" message; the hint shows only to someone who can start a post. */
function paintEmpty(
  els: { readonly emptyTitle: HTMLElement; readonly emptyHint: HTMLElement },
  selectedCount: number,
  canSend: boolean,
): void {
  setText(els.emptyTitle, forumsText(selectedCount > 0 ? "empty.tags" : "empty.none"));
  setText(els.emptyHint, selectedCount > 0 ? "" : forumsText("empty.noneHint"));
  els.emptyHint.hidden = selectedCount > 0 || !canSend;
}

/** The empty state, the loading/failed line and the load-more button.
 *  `sections` are the open and the archived halves; the "no posts" hint shows
 *  only to someone who can start a post. */
export function paintForumFooter(
  els: {
    readonly emptyEl: HTMLElement;
    readonly emptyTitle: HTMLElement;
    readonly emptyHint: HTMLElement;
    readonly statusEl: HTMLElement;
    readonly moreBtn: HTMLElement;
  },
  sections: readonly [Section, Section],
  postCount: number,
  selectedCount: number,
  canSend: boolean,
): void {
  const [open, older] = sections;
  const busy = open.loading || older.loading;
  const done = !open.hasMore && !older.hasMore;
  const failed = open.failed || older.failed;
  const empty = done && !busy && !failed && postCount === 0;
  els.emptyEl.hidden = !empty;
  if (empty) paintEmpty(els, selectedCount, canSend);
  setText(
    els.statusEl,
    busy ? forumsText("list.loading") : failed ? forumsText("list.failed") : "",
  );
  els.moreBtn.hidden = busy || (done && !failed);
  setText(els.moreBtn, forumsText(failed ? "list.retry" : "list.loadMore"));
}

/** Show or hide the guidelines banner and its toggle for the channel topic. */
export function paintGuidelines(
  els: {
    readonly guidelines: HTMLElement;
    readonly guidelinesToggle: HTMLElement;
    readonly guidelinesBody: HTMLElement;
  },
  topic: string,
  guidelinesOpen: boolean,
): void {
  const { guidelines, guidelinesToggle, guidelinesBody } = els;
  guidelines.hidden = topic === "" || !guidelinesOpen;
  guidelinesToggle.hidden = topic === "";
  setText(guidelinesBody, topic);
  guidelinesBody.hidden = !guidelinesOpen;
  guidelinesToggle.setAttribute("aria-expanded", String(guidelinesOpen));
  guidelinesToggle.replaceChildren(
    createIcon(guidelinesOpen ? "chevron-down" : "chevron-right", 14),
    ` ${forumsText("guidelines.title")}`,
  );
}

/** Press the button of `active` and release the others. */
export function markPressed<T>(buttons: ReadonlyMap<T, HTMLElement>, active: T): void {
  for (const [value, btn] of buttons) btn.setAttribute("aria-pressed", String(value === active));
}

/** Marks the shown layout on the view, and on the page shell while a reader
 *  sits beside the list, so the stylesheet needs no page-wide `:has()`. */
export function createLayoutPainter(root: HTMLElement): {
  paint: (shown: ForumLayout) => void;
  release: () => void;
} {
  let shell: Element | null = null;
  return {
    paint(shown) {
      for (const value of FORUM_LAYOUTS)
        root.classList.toggle(`forum-view--${value}`, value === shown);
      const app = root.closest(".app");
      if (app === null) return;
      shell = app;
      app.classList.toggle("app--forum-split", shown === "split");
    },
    release() {
      if (shell === null) return;
      // A newer forum view may already be mounted beside the split.
      const other = [...shell.querySelectorAll(".forum-view--split")].some((el) => el !== root);
      if (!other) shell.classList.remove("app--forum-split");
    },
  };
}
