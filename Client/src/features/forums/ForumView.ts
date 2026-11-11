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

import { setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { errorText } from "@lib/api";
import { createLogger } from "@lib/logger";
import { loadPref, savePref } from "@lib/prefs/preferences";
import { isPhoneLayout, onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import type { ForumTag, ThreadInfo } from "@lib/types";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { adoptThreadSnapshots, threadsStore, upsertThread } from "@stores/threads.store";
import { threadAgoLabel } from "../threads/threadAgo";
import { forumsText } from "../../i18n/forums";
import type { ForumViewContext } from "../navigation/destinations";
import {
  FORUM_GUIDELINES_PREF,
  FORUM_LAYOUT_PREF,
  MAX_TAG_FILTERS,
  parseForumLayout,
  matchesTags,
  postListQuery,
  sortPosts,
  type ForumLayout,
  type ForumSort,
} from "./forumModel";
import { authorName, previewOf, syncChildren } from "./postRowParts";
import { freshSection, sortKey, type Section } from "./forumViewModel";
import {
  buildForumHeader,
  buildForumList,
  buildPostRow,
  createLayoutPainter,
  markCurrentPost,
  markPressed,
  paintForumFooter,
  paintGuidelines,
  paintTagBar,
  postRowSignature,
} from "./forumViewParts";

const log = createLogger("forum-view");

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
  // A phone starts with the guidelines folded so the posts are on screen.
  let guidelinesOpen = loadPref<boolean>(FORUM_GUIDELINES_PREF, !isPhoneLayout());
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

  const {
    header,
    guidelines,
    guidelinesToggle,
    guidelinesBody,
    newPostBtn,
    sortButtons,
    layoutButtons,
    tagBar,
  } = buildForumHeader(channelId);

  // ── List ──────────────────────────────────────────────────────────────────

  const {
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
  } = buildForumList();

  root.replaceChildren(header, scroller);

  // ── Rows ──────────────────────────────────────────────────────────────────

  function tagLabels(post: ThreadInfo): string[] {
    const ids = post.post?.tag_ids ?? [];
    return forumTags()
      .filter((tag) => ids.includes(tag.id))
      .map((tag) => `${tag.emoji ?? ""} ${tag.name}`.trim());
  }

  function rowFor(post: ThreadInfo): HTMLLIElement {
    const labels = tagLabels(post);
    const author = authorName(post);
    const ago = threadAgoLabel(post.last_message_at ?? post.created_at);
    const preview = previewOf(post);
    const sig = postRowSignature(post, preview.text, labels, author, ago);
    const cached = rowCache.get(post.id);
    if (cached?.sig === sig) return cached.el;
    const el = buildPostRow(ctx, signal, post, labels, author, ago);
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

  /** The empty state, the loading/failed line and the load-more button. */
  const paintFooter = (postCount: number): void =>
    paintForumFooter(
      { emptyEl, emptyTitle, emptyHint, statusEl, moreBtn },
      [open, older],
      postCount,
      selected.size,
      forumChannel()?.canSend ?? false,
    );

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

    paintFooter(posts.length);

    markCurrent();

    if (focusedId !== undefined) {
      const back = root.querySelector<HTMLElement>(`[data-post-id="${focusedId}"]`);
      if (back !== null && back !== document.activeElement) back.focus();
    }
  }

  /** The post open in the side panel is marked in the list. */
  const markCurrent = (): void =>
    markCurrentPost(root, String(threadsStore.getState().focusedThreadId ?? ""));

  /** The stored layout, except that a phone has no room for a reader beside the list. */
  function shownLayout(): ForumLayout {
    return layout === "split" && isPhoneLayout() ? "list" : layout;
  }

  const layoutPainter = createLayoutPainter(root);
  disposable.addCleanup(layoutPainter.release);

  function paintHeader(): void {
    const channel = forumChannel();
    const topic = (channel?.topic ?? "").trim();
    paintGuidelines({ guidelines, guidelinesToggle, guidelinesBody }, topic, guidelinesOpen);
    newPostBtn.hidden = channel?.canSend === false;
    markPressed(sortButtons, sort);
    markPressed(layoutButtons, layout);
    layoutPainter.paint(shownLayout());

    const tags = forumTags();
    tagBar.hidden = tags.length === 0;
    paintTagBar(tagBar, tags, selected, signal, toggleTag, () => setSelection(new Set()));
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

  /** Fold a landed page into the section it belongs to. */
  function applyPage(
    section: Section,
    page: { threads: readonly ThreadInfo[]; has_more: boolean; next_before: string },
  ): void {
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
      applyPage(section, page);
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
  onPhoneLayoutChange(() => paintHeader(), signal);
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
