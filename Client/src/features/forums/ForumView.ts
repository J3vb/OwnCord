/**
 * A forum channel's post list, mounted in the messages slot in place
 * of the message list: the guidelines banner (the channel topic), New Post, the
 * sort toggle, the tag filter, then the posts, then "Older posts" (archived).
 *
 * Paging is view-local and dies with the channel's signal: the cursor, the ids
 * fetched so far, the filter. The posts themselves live in threadsStore, which
 * the dispatcher keeps current from `thread_changed` frames (sequenced on the
 * forum, so a socket viewing it hears every post). The list shows the posts it
 * paged plus every post a live frame touched since it mounted, deduped by id
 * and sorted again locally, so a post that takes a reply jumps to the top. The
 * server's cursor is a snapshot of the order at fetch time; a post that moved
 * above it between pages is not returned by a later page, which this merge makes
 * up for.
 */

import { createElement, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import { createLogger } from "@lib/logger";
import { avatarInitial, resolveDisplayName } from "@lib/avatar";
import { loadPref, savePref } from "@lib/preferences";
import type { ForumTag, ThreadInfo } from "@lib/types";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { membersStore } from "@stores/members.store";
import { adoptThreadSnapshots, threadsStore, upsertThread } from "@stores/threads.store";
import { threadAgoLabel } from "../threads/threadAgo";
import { forumsText } from "../../i18n/forums";
import type { ForumViewContext } from "../navigation/destinations";
import {
  FORUM_GUIDELINES_PREF,
  FORUM_LAYOUTS,
  FORUM_LAYOUT_PREF,
  MAX_TAG_FILTERS,
  activityMs,
  parseForumLayout,
  matchesTags,
  postListQuery,
  replyCount,
  sortPosts,
  type ForumLayout,
  type ForumSort,
} from "./forumModel";

const log = createLogger("forum-view");

const LAYOUT_LABEL = {
  grid: "layout.grid",
  list: "layout.list",
  split: "layout.split",
  feed: "layout.feed",
} as const satisfies Record<ForumLayout, string>;

/** One half of the list (open or archived) and how far it has been paged. */
interface Section {
  cursor: string;
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  /** At least one page of it has landed. */
  started: boolean;
}

const freshSection = (): Section => ({
  cursor: "",
  hasMore: true,
  loading: false,
  failed: false,
  started: false,
});

function authorOf(post: ThreadInfo) {
  const id = post.owner_id ?? post.post?.first_message?.author_id ?? null;
  return id === null ? undefined : membersStore.getState().members.get(id);
}

function authorName(post: ThreadInfo): string {
  const member = authorOf(post);
  return member === undefined ? forumsText("post.unknownAuthor") : resolveDisplayName(member);
}

function previewOf(post: ThreadInfo): { text: string; muted: boolean } {
  const first = post.post?.first_message ?? null;
  if (first === null || first.deleted) return { text: forumsText("post.deleted"), muted: true };
  if (first.preview !== "") return { text: first.preview, muted: false };
  return first.has_attachments
    ? { text: forumsText("post.attachment"), muted: true }
    : { text: "", muted: true };
}

/** The number a post is ranked by under `sort`. */
function sortKey(post: ThreadInfo, sort: ForumSort): number {
  return sort === "created" ? post.id : activityMs(post);
}

/** Put `els` in `ul` in order, moving only what is out of place. */
function syncChildren(ul: HTMLElement, els: readonly HTMLElement[]): void {
  els.forEach((el, i) => {
    if (ul.children[i] !== el) ul.insertBefore(el, ul.children[i] ?? null);
  });
  while (ul.children.length > els.length) ul.lastElementChild?.remove();
}

export function renderForumView(root: HTMLElement, ctx: ForumViewContext): void {
  const { channelId, api, ws } = ctx;
  const disposable = new Disposable();
  const { signal } = disposable;
  ctx.signal.addEventListener("abort", () => disposable.destroy(), { once: true });
  if (ctx.signal.aborted) {
    disposable.destroy();
    return;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  let sort: ForumSort = "activity";
  let selected = new Set<number>();
  let open = freshSection();
  let older = freshSection();
  /** Bumped by every restart of the list, so only the newest answers apply. */
  let gen = 0;
  /** Post ids the pages fetched, and ids a live frame touched since mount. */
  const paged = new Set<number>();
  const live = new Set<number>();
  /** The last state of each of this forum's posts that we looked at. */
  const seen = new Map<number, ThreadInfo>();
  /** True while this view itself writes a page into the store (not a live frame). */
  let writing = false;
  let guidelinesOpen = loadPref<boolean>(FORUM_GUIDELINES_PREF, true);
  let layout: ForumLayout = parseForumLayout(loadPref<string>(FORUM_LAYOUT_PREF, "grid"));
  /** A refresh keeps the rows on screen until its first page lands, then swaps. */
  let refreshing = false;
  /** The New Post dialog is loading or open: one at a time. */
  let dialogBusy = false;
  const rowCache = new Map<number, { sig: string; el: HTMLLIElement }>();

  const forumChannel = () => channelsStore.getState().channels.get(channelId);
  const forumTags = (): readonly ForumTag[] =>
    (forumChannel()?.forum?.tags ?? []).toSorted((a, b) => a.position - b.position || a.id - b.id);

  // ── Header ────────────────────────────────────────────────────────────────

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
  newPostBtn.append(createIcon("pencil", 14), ` ${forumsText("newPost")}`);

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

  // ── List ──────────────────────────────────────────────────────────────────

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

  root.replaceChildren(header, scroller);

  // ── Rows ──────────────────────────────────────────────────────────────────

  function tagLabels(post: ThreadInfo): string[] {
    const ids = post.post?.tag_ids ?? [];
    return forumTags()
      .filter((tag) => ids.includes(tag.id))
      .map((tag) => `${tag.emoji ?? ""} ${tag.name}`.trim());
  }

  function buildRow(
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
        replies === 0
          ? forumsText("post.noReplies")
          : forumsText("post.replies", { count: replies }),
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

  function rowFor(post: ThreadInfo): HTMLLIElement {
    const labels = tagLabels(post);
    const author = authorName(post);
    const ago = threadAgoLabel(post.last_message_at ?? post.created_at);
    const preview = previewOf(post);
    const sig = [
      post.name,
      post.archived,
      post.locked,
      post.message_count,
      preview.text,
      labels.join("\u0000"),
      author,
      ago,
    ].join("|");
    const cached = rowCache.get(post.id);
    if (cached?.sig === sig) return cached.el;
    const el = buildRow(post, labels, author, ago);
    rowCache.set(post.id, { sig, el });
    return el;
  }

  // ── Paint ─────────────────────────────────────────────────────────────────

  function candidates(): ThreadInfo[] {
    const { byId } = threadsStore.getState();
    const found: ThreadInfo[] = [];
    for (const id of new Set([...paged, ...live])) {
      const post = byId.get(id);
      if (post !== undefined && post.parent_id === channelId && matchesTags(post, selected)) {
        found.push(post);
      }
    }
    return sortPosts(found, sort);
  }

  function paintList(): void {
    const focusedId =
      document.activeElement?.closest<HTMLElement>("[data-post-id]")?.dataset["postId"];
    const posts = candidates();
    const visible = new Set(posts.map((p) => p.id));
    for (const id of rowCache.keys()) if (!visible.has(id)) rowCache.delete(id);
    syncChildren(openList, posts.filter((p) => !p.archived).map(rowFor));
    const archivedPosts = posts.filter((p) => p.archived);
    syncChildren(olderList, archivedPosts.map(rowFor));
    olderHead.hidden = archivedPosts.length === 0;
    olderList.hidden = archivedPosts.length === 0;

    const busy = open.loading || older.loading;
    const done = !open.hasMore && !older.hasMore;
    const failed = open.failed || older.failed;
    const empty = done && !busy && !failed && posts.length === 0;
    emptyEl.hidden = !empty;
    if (empty) {
      setText(emptyTitle, forumsText(selected.size > 0 ? "empty.tags" : "empty.none"));
      setText(emptyHint, selected.size > 0 ? "" : forumsText("empty.noneHint"));
      emptyHint.hidden = selected.size > 0 || !(forumChannel()?.canSend ?? false);
    }
    setText(statusEl, busy ? forumsText("list.loading") : failed ? forumsText("list.failed") : "");
    moreBtn.hidden = busy || (done && !failed);
    setText(moreBtn, forumsText(failed ? "list.retry" : "list.loadMore"));

    markCurrent();

    if (focusedId !== undefined) {
      const back = root.querySelector<HTMLElement>(`[data-post-id="${focusedId}"]`);
      if (back !== null && back !== document.activeElement) back.focus();
    }
  }

  /** The post open in the side panel is marked in the list. */
  function markCurrent(): void {
    const current = String(threadsStore.getState().focusedThreadId ?? "");
    for (const btn of root.querySelectorAll<HTMLElement>("[data-post-id]")) {
      const on = btn.dataset["postId"] === current;
      btn.classList.toggle("current", on);
      if (on) btn.setAttribute("aria-current", "true");
      else btn.removeAttribute("aria-current");
    }
  }

  function paintHeader(): void {
    const channel = forumChannel();
    const topic = (channel?.topic ?? "").trim();
    guidelines.hidden = topic === "" || !guidelinesOpen;
    guidelinesToggle.hidden = topic === "";
    setText(guidelinesBody, topic);
    guidelinesBody.hidden = !guidelinesOpen;
    guidelinesToggle.setAttribute("aria-expanded", String(guidelinesOpen));
    guidelinesToggle.replaceChildren(
      createIcon(guidelinesOpen ? "chevron-down" : "chevron-right", 14),
      ` ${forumsText("guidelines.title")}`,
    );
    newPostBtn.hidden = channel?.canSend === false;
    for (const [value, btn] of sortButtons)
      btn.setAttribute("aria-pressed", String(value === sort));
    for (const [value, btn] of layoutButtons)
      btn.setAttribute("aria-pressed", String(value === layout));
    for (const value of FORUM_LAYOUTS)
      root.classList.toggle(`forum-view--${value}`, value === layout);

    const tags = forumTags();
    tagBar.hidden = tags.length === 0;
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
      chip.addEventListener("click", () => toggleTag(tag.id), { signal });
      return chip;
    });
    const clear = createElement(
      "button",
      { type: "button", class: "forum-tag-clear", "data-testid": "forum-tag-clear" },
      forumsText("tags.clear"),
    );
    clear.hidden = selected.size === 0;
    clear.addEventListener("click", () => setSelection(new Set()), { signal });
    const focusedTag = document.activeElement?.getAttribute("data-tag-id");
    tagBar.replaceChildren(...chips, clear);
    if (focusedTag != null) {
      tagBar.querySelector<HTMLElement>(`[data-tag-id="${focusedTag}"]`)?.focus();
    }
  }

  // ── Paging ────────────────────────────────────────────────────────────────

  let observer: IntersectionObserver | null = null;
  /** Re-observing makes the browser report the sentinel again, so a page that
   *  left it on screen loads the next one. */
  function rearm(): void {
    if (observer === null) return;
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  /** Sync `seen` with the store: a changed post of this forum was touched by a live frame. */
  function syncSeen(): void {
    for (const [id, post] of threadsStore.getState().byId) {
      if (post.parent_id !== channelId || seen.get(id) === post) continue;
      seen.set(id, post);
      if (!writing) live.add(id);
    }
  }

  /**
   * After the first open page lands: posts the store already holds for this
   * forum, not in the page, that rank inside it (a `thread_changed` that
   * arrived before this view had mounted) are live news too.
   */
  function adoptStoredNewer(posts: readonly ThreadInfo[], hasMore: boolean): void {
    // A last page is the whole list: nothing outside it can rank inside it.
    if (!hasMore || posts.length === 0) return;
    const floor = Math.min(...posts.map((p) => sortKey(p, sort)));
    const inPage = new Set(posts.map((p) => p.id));
    for (const [id, post] of threadsStore.getState().byId) {
      if (post.parent_id !== channelId || post.archived || inPage.has(id)) continue;
      if (sortKey(post, sort) >= floor) live.add(id);
    }
  }

  function writePage(posts: readonly ThreadInfo[]): void {
    // Live frames the store already holds but has not announced yet count as
    // live before this page's own writes are folded in.
    syncSeen();
    writing = true;
    try {
      // A live frame outranks the page that was read before it landed; a post
      // no live frame touched takes the page's state (its tags or archive flag
      // may have changed while this forum was not on screen).
      adoptThreadSnapshots(posts.filter((p) => live.has(p.id)));
      for (const post of posts) if (!live.has(post.id)) upsertThread(post);
      syncSeen();
    } finally {
      writing = false;
    }
    for (const post of posts) paged.add(post.id);
  }

  async function loadMore(): Promise<void> {
    const section = open.hasMore ? open : older.hasMore ? older : null;
    if (section === null || section.loading) return;
    const archived = section === older;
    const myGen = gen;
    section.loading = true;
    section.failed = false;
    paintList();
    let landed = false;
    try {
      const page = await api.listThreads(
        channelId,
        postListQuery({ sort, tags: [...selected], archived, cursor: section.cursor }),
        ctx.signal,
      );
      if (myGen !== gen || ctx.signal.aborted) return;
      if (refreshing && section === open) {
        // A refresh: what the old pages showed is replaced by the new first page.
        refreshing = false;
        paged.clear();
        live.clear();
      }
      writePage(page.threads);
      if (section === open && !section.started) adoptStoredNewer(page.threads, page.has_more);
      section.cursor = page.next_before;
      section.hasMore = page.has_more;
      section.started = true;
      landed = true;
    } catch (err) {
      if (myGen !== gen || ctx.signal.aborted) return;
      section.failed = true;
      log.warn("Forum post list failed", { error: errorText(err, "") });
    } finally {
      if (myGen === gen) {
        section.loading = false;
        paintList();
      }
    }
    if (!landed || myGen !== gen) return;
    // The open posts are done: the first page of the older ones follows at once.
    if (!open.hasMore && !older.started) void loadMore();
    else rearm();
  }

  /** Start the list again (filter or sort changed): drop the pages, keep live posts out. */
  function restart(): void {
    gen++;
    refreshing = false;
    open = freshSection();
    older = freshSection();
    paged.clear();
    live.clear();
    paintHeader();
    paintList();
    void loadMore();
  }

  /** After a reconnect: refetch from the first page, keeping the rows until it lands. */
  function refresh(): void {
    gen++;
    refreshing = true;
    open = freshSection();
    older = freshSection();
    paintList();
    void loadMore();
  }

  function setSelection(next: Set<number>): void {
    selected = next;
    restart();
  }

  function toggleTag(id: number): void {
    const next = new Set(selected);
    if (!next.delete(id)) {
      if (next.size >= MAX_TAG_FILTERS) return;
      next.add(id);
    }
    setSelection(next);
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  for (const [value, btn] of sortButtons) {
    btn.addEventListener(
      "click",
      () => {
        if (sort === value) return;
        sort = value;
        restart();
      },
      { signal },
    );
  }
  guidelinesToggle.addEventListener(
    "click",
    () => {
      guidelinesOpen = !guidelinesOpen;
      savePref(FORUM_GUIDELINES_PREF, guidelinesOpen);
      paintHeader();
    },
    { signal },
  );
  for (const [value, btn] of layoutButtons) {
    btn.addEventListener(
      "click",
      () => {
        if (layout === value) return;
        layout = value;
        savePref(FORUM_LAYOUT_PREF, value);
        paintHeader();
      },
      { signal },
    );
  }
  moreBtn.addEventListener("click", () => void loadMore(), { signal });
  newPostBtn.addEventListener(
    "click",
    () => {
      if (dialogBusy) return;
      dialogBusy = true;
      newPostBtn.disabled = true;
      const release = (): void => {
        dialogBusy = false;
        newPostBtn.disabled = false;
      };
      errorEl.hidden = true;
      import("./NewPostDialog").then(
        ({ openNewPostDialog }) => {
          if (ctx.signal.aborted) return;
          openNewPostDialog({
            ws,
            api,
            channelId,
            signal: ctx.signal,
            fallbackFocus: () => newPostBtn,
            onCreated: (post) => ctx.openPost(post.id),
            onClosed: release,
          });
        },
        (err: unknown) => {
          log.error("New post dialog failed to load", { error: String(err) });
          release();
          if (ctx.signal.aborted) return;
          setText(errorEl, forumsText("dialog.loadFailed"));
          errorEl.hidden = false;
        },
      );
    },
    { signal },
  );

  if (typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver(
      (entries) => {
        // A failed section waits for its Retry button instead of looping.
        if (open.failed || older.failed) return;
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { root: scroller },
    );
    observer.observe(sentinel);
    disposable.addCleanup(() => observer?.disconnect());
  }

  // Posts already in the store before we mounted are not live news.
  writing = true;
  syncSeen();
  writing = false;
  disposable.onStoreChange(
    threadsStore,
    (s) => s.byId,
    () => {
      syncSeen();
      if (!writing) paintList();
    },
  );
  disposable.onStoreChange(threadsStore, (s) => s.focusedThreadId, markCurrent);
  // A reconnect: frames were missed, so the list is read again.
  let wasConnected = uiStore.getState().connectionStatus === "connected";
  disposable.onStoreChange(
    uiStore,
    (s) => s.connectionStatus,
    (status) => {
      const connected = status === "connected";
      if (connected && !wasConnected) refresh();
      wasConnected = connected;
    },
  );
  // A tag edit, a retopic or a permission change repaints the header and rows;
  // a filter on a tag the forum no longer has is dropped.
  disposable.onStoreChange(
    channelsStore,
    (s) => s.channels.get(channelId),
    () => {
      const known = new Set(forumTags().map((t) => t.id));
      const kept = new Set([...selected].filter((id) => known.has(id)));
      if (kept.size !== selected.size) {
        setSelection(kept);
        return;
      }
      rowCache.clear();
      paintHeader();
      paintList();
    },
  );
  disposable.addCleanup(() => {
    rowCache.clear();
    paged.clear();
    live.clear();
    seen.clear();
  });

  paintHeader();
  paintList();
  void loadMore();
}
