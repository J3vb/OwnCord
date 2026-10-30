/**
 * Scrolling in the message list: following the bottom, the jump buttons,
 * loading older and newer pages, and jumping to one message.
 */
import {
  getChannelMessages,
  hasMoreMessages,
  hasOlderLoadFailed,
  isWindowDetached,
  type Message,
} from "@stores/messages.store";
import { formatBadgeCount } from "@lib/text/formatting";
import { messagingText } from "../../i18n/messaging";
import { setLiveTailInView } from "@lib/readState";
import {
  SCROLL_TOP_THRESHOLD,
  SCROLL_TOP_VIEWPORTS,
  SCROLL_BOTTOM_VIEWPORTS,
  OLDER_RETRY_COOLDOWN_MS,
  SCROLL_BOTTOM_THRESHOLD,
  JUMP_RECENTRE_MS,
  PAGE_SCROLL_FRACTION,
  type ScrollMetrics,
  readMetrics,
} from "./listShared";
import type { ListState, ListApi } from "./listState";

export function createListScroll(st: ListState, api: ListApi) {
  const ownSends = (list: readonly Message[]): number =>
    list.filter(
      (m) =>
        m.id === 0 &&
        m.user.id === st.options.currentUserId &&
        (m.status === "pending" || m.status === "failed" || m.status === "uploading") &&
        !(m.correlationId?.startsWith("recovered:") ?? false),
    ).length;

  const followOwnSend = (): boolean =>
    performance.now() < st.followOwnSendUntil && !isWindowDetached(st.options.channelId);

  // Once attached, a newer page in flight can no longer land, so it does not
  // veto the reader's own send.
  const keepBottom = (): boolean => (isNearBottom() && !st.loadingNewer) || followOwnSend();

  /** The one place the list moves the viewport: a write invalidates the frame's
   *  snapshot, so the rAF cannot render for the position from before it. */
  function setScrollTop(top: number): void {
    if (st.root === null) return;
    st.scrollSnapshot = null;
    st.root.scrollTop = top;
  }

  function isNearBottom(threshold = SCROLL_BOTTOM_THRESHOLD, m?: ScrollMetrics): boolean {
    if (st.root === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(st.root);
    return scrollHeight - scrollTop - clientHeight < threshold;
  }

  /** The true bottom (1 px tolerates fractional scrollTop on HiDPI), unlike the 100 px isNearBottom. */
  function isAtBottom(m?: ScrollMetrics): boolean {
    if (st.root === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(st.root);
    return scrollHeight - scrollTop - clientHeight <= 1;
  }

  function scrollToBottom(): void {
    if (st.root === null) return;
    setScrollTop(st.root.scrollHeight);
  }

  function bottomGap(m?: ScrollMetrics): number {
    if (st.root === null) return 0;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(st.root);
    return scrollHeight - scrollTop - clientHeight;
  }

  function updateScrollToBottomBtn(m?: ScrollMetrics): void {
    if (st.scrollToBottomBtn === null) return;
    const near = isNearBottom(SCROLL_BOTTOM_THRESHOLD, m);
    if (near) st.newBelowCount = 0;
    const key = `${near ? 1 : 0}:${st.newBelowCount}`;
    if (key === st.btnShownKey) return;
    st.btnShownKey = key;
    st.scrollToBottomBtn.classList.toggle("visible", !near);
    if (st.scrollToBottomCount === null) return;
    const shown = formatBadgeCount(st.newBelowCount);
    st.scrollToBottomCount.hidden = st.newBelowCount === 0;
    st.scrollToBottomCount.textContent = st.newBelowCount === 0 ? "" : shown;
    st.scrollToBottomBtn.setAttribute(
      "aria-label",
      st.newBelowCount === 0
        ? messagingText("scrollToBottom")
        : messagingText("scrollToBottomNew", { count: st.newBelowCount, shown }),
    );
  }

  /** The pill is the only signal that the bottom of the list is not "now". */
  function updateJumpToPresentPill(): void {
    if (st.jumpToPresentPill === null) return;
    st.jumpToPresentPill.classList.toggle("visible", isWindowDetached(st.options.channelId));
  }

  function scrollPage(direction: 1 | -1): void {
    if (st.root === null) return;
    // About what the browser's own PageDown moves, keeping a line of context.
    setScrollTop(
      st.root.scrollTop + direction * Math.round(st.root.clientHeight * PAGE_SCROLL_FRACTION),
    );
  }

  function setLoadingOlder(value: boolean): void {
    st.loadingOlder = value;
    if (!value) st.olderLoadingRow?.remove();
    else if (st.olderLoadingRow !== null) st.root?.appendChild(st.olderLoadingRow);
    updateOlderFailedRow();
  }

  function updateOlderFailedRow(): void {
    if (st.olderFailedRow === null) return;
    st.olderFailedRow.hidden = st.loadingOlder || !hasOlderLoadFailed(st.options.channelId);
  }

  /** An explicit Retry click: goes at once, past the automatic-retry cooldown. */
  function retryOlder(): void {
    if (st.loadingOlder) return;
    st.olderRetryAt = 0;
    fireOlderLoad();
    // The row hides while the page loads: keep keyboard focus in the list.
    st.root?.focus({ preventScroll: true });
  }

  /** The newest delivered row's id (optimistic rows carry id 0). */
  function lastSentId(): number {
    return getChannelMessages(st.options.channelId).findLast((m) => m.id > 0)?.id ?? 0;
  }

  function fireOlderLoad(): void {
    setLoadingOlder(true);
    const oldestAtFire = getChannelMessages(st.options.channelId)[0]?.id;
    // A failed fetch never changes the message count, so the subscriber
    // above (which only reacts to a count change) would leave loadingOlder
    // latched forever. Clear it once the load settles either way — the
    // subscriber's reset still applies to the success path but is now just
    // belt-and-braces.
    void Promise.resolve(st.options.onScrollTop()).finally(() => {
      setLoadingOlder(false);
      // Nothing was prepended: hold off so continued scrolling in the zone
      // does not send one failing request after another.
      if (getChannelMessages(st.options.channelId)[0]?.id === oldestAtFire) {
        st.olderRetryAt = performance.now() + OLDER_RETRY_COOLDOWN_MS;
      }
      // With every loaded row deleted there is nothing else to redraw the
      // region: show the outcome (the next page, or the failure and Retry).
      if (st.virtualItems.length === 0 && !st.disposable.signal.aborted) api.renderWindow();
    });
  }

  function handleScroll(): void {
    if (st.root === null) return;

    // Load older messages well before the top; the floor keeps the
    // trigger working when the viewport has no height yet.
    // The frame's only layout read: everything below, and the rAF's renderWindow,
    // works from this snapshot, so the DOM writes in between cannot force a
    // second layout.
    const m = readMetrics(st.root);
    st.scrollSnapshot = m;
    if (m.clientHeight > 0) st.bottomGapBeforeResize = bottomGap(m);
    const nearTop =
      m.scrollTop < Math.max(SCROLL_TOP_THRESHOLD, m.clientHeight * SCROLL_TOP_VIEWPORTS);
    if (!nearTop) st.olderRetryAt = 0;
    if (
      nearTop &&
      !st.loadingOlder &&
      performance.now() >= st.olderRetryAt &&
      hasMoreMessages(st.options.channelId)
    ) {
      fireOlderLoad();
    }

    // A detached window pages DOWN toward the present as the reader nears its
    // bottom; the page that reaches the newest message reattaches it.
    const nearBottomZone = isNearBottom(
      Math.max(SCROLL_BOTTOM_THRESHOLD, m.clientHeight * SCROLL_BOTTOM_VIEWPORTS),
      m,
    );
    if (!nearBottomZone) st.newerRetryAt = 0;
    if (
      nearBottomZone &&
      st.options.onScrollBottom !== undefined &&
      !st.loadingNewer &&
      performance.now() >= st.newerRetryAt &&
      isWindowDetached(st.options.channelId)
    ) {
      st.loadingNewer = true;
      const newestAtFire = lastSentId();
      void Promise.resolve(st.options.onScrollBottom()).finally(() => {
        st.loadingNewer = false;
        // Nothing landed (failed, or the window was replaced): hold off so
        // continued scrolling does not send one failing request after another.
        if (lastSentId() === newestAtFire)
          st.newerRetryAt = performance.now() + OLDER_RETRY_COOLDOWN_MS;
      });
    }

    // Update floating scroll-to-bottom button visibility
    updateScrollToBottomBtn(m);
    // Before markReadIfSeen, which asks isChannelAway. The 100 px auto-scroll
    // threshold on purpose: inside it a new message is scrolled into view.
    setLiveTailInView(st.options.channelId, isNearBottom(SCROLL_BOTTOM_THRESHOLD, m));
    // Reaching the bottom counts as seeing it.
    api.markReadIfSeen(m);

    // Debounce virtual window updates to animation frames
    if (st.scrollRafId === 0) {
      st.scrollRafId = requestAnimationFrame(() => {
        st.scrollRafId = 0;
        api.renderWindow(st.scrollSnapshot ?? undefined);
      });
    }
  }

  /** Scroll so row `idx` sits `offset` px below the top of the view and
   *  render there; false when it already does. Each pass can build and
   *  measure rows above the target, moving it, so callers settle in a few. */
  function placeIndex(idx: number, offset: number): boolean {
    if (st.root === null) return false;
    const target = Math.max(0, api.offsetBefore(idx) + offset);
    if (Math.abs(target - st.root.scrollTop) < 1) return false;
    setScrollTop(target);
    api.renderWindow();
    return true;
  }

  /** Scroll so row `idx` is centred; false when it was already centred. */
  function centreOnIndex(idx: number): boolean {
    if (st.root === null) return false;
    return placeIndex(idx, -(st.root.clientHeight - api.getItemHeight(idx)) / 2);
  }

  function scrollToMessage(messageId: number): boolean {
    if (st.root === null) return false;
    const idx = st.virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
    if (idx === -1) {
      if (!expandRunOf(messageId)) return false;
      api.rebuildItems();
      const at = st.virtualItems.findIndex(
        (item) => item.kind === "message" && item.message.id === messageId,
      );
      if (at !== -1 && revealIndex(at, true)) return true;
      api.renderAll();
      return false;
    }
    return revealIndex(idx, true);
  }

  /** Message ids of the blocked run spanning `firstId`..`lastId`. */
  function runIds(firstId: number, lastId: number): number[] {
    return st.allMessages.filter((m) => m.id >= firstId && m.id <= lastId).map((m) => m.id);
  }

  /** Open the collapsed run `messageId` sits in; false when it is in none. */
  function expandRunOf(messageId: number): boolean {
    const run = st.virtualItems.find(
      (item) =>
        item.kind === "blocked-run" &&
        !item.expanded &&
        item.firstId <= messageId &&
        messageId <= item.lastId,
    );
    if (run?.kind !== "blocked-run") return false;
    const members = runIds(run.firstId, run.lastId);
    if (!members.includes(messageId)) return false;
    for (const id of members) st.shownBlocked.add(id);
    return true;
  }

  /** Show or Hide the run headed by `firstId`, read from the current items (the
   *  row a click came from may be older than the run), holding its header in place. */
  function toggleBlockedRun(firstId: number): void {
    const key = `blk-${firstId}`;
    const at = st.virtualItems.findIndex((item, i) => api.keyOf(item, i) === key);
    const run = st.virtualItems[at];
    if (run?.kind !== "blocked-run") return;
    for (const id of runIds(run.firstId, run.lastId)) {
      if (run.expanded) st.shownBlocked.delete(id);
      else st.shownBlocked.add(id);
    }
    const el = api.renderedRowAt(at);
    api.renderAll(el === undefined ? undefined : { key, edge: api.edgeOf(el) });
  }

  /** Centre row `idx` in the view, rendering it; with `flash`, highlight it too. */
  function revealIndex(idx: number, flash: boolean, recentre = true): boolean {
    if (st.root === null) return false;
    const item = st.virtualItems[idx];
    if (item?.kind !== "message") return false;
    const messageId = item.message.id;
    setScrollTop(api.offsetBefore(idx));
    // Force the rebuild path: a scroll-driven renderWindow only moves spacers,
    // so without this the target row can sit outside the rendered window and
    // there is nothing to flash (and nothing to look at after the scroll).
    st.renderedStart = -1;
    api.renderWindow();

    // renderWindow's own rapid-rebuild breaker can return before reassigning
    // renderedStart (it stays -1, the value forced above) when too many
    // rebuilds have fired in the last 2s. When that happens the DOM was never
    // rebuilt for this target — report a failed jump rather than computing a
    // localIdx against a sentinel and flashing/reporting success for a row
    // that never rendered. This lets callers (e.g. MessageJump) fall back to
    // fetching the around-window instead of treating this as a landed jump.
    if (st.renderedStart < 0) return false;

    // Rendering measured the target (and its neighbours), so the top-aligned
    // offset above was built from estimates. Centre it with the real height.
    // Each move can render and measure new rows above the target, shifting
    // its offset again, so settle for a few passes (usually one or two).
    for (let pass = 0; pass < 3; pass++) {
      if (!centreOnIndex(idx)) break;
    }
    // Late-sizing content (previews, images) above the target keeps it
    // centred until the highlight flash ends.
    // The editor is not a jump: resizes must not pull it back to the centre.
    if (recentre) st.jumpTarget = { messageId, until: Date.now() + JUMP_RECENTRE_MS };

    // Briefly highlight the target message element
    if (flash && st.contentContainer !== null) {
      const localIdx = idx - st.renderedStart;
      const el = st.contentContainer.children[localIdx] as HTMLElement | undefined;
      if (el !== undefined) {
        // A prior flash still pending (rapid repeat jumps) must not linger on
        // its now-stale row, and must not leave its timer live once replaced.
        if (st.flashTimer !== 0) {
          clearTimeout(st.flashTimer);
          st.flashEl?.classList.remove("highlight-flash");
        }
        el.classList.add("highlight-flash");
        st.flashEl = el;
        st.flashTimer = window.setTimeout(() => {
          el.classList.remove("highlight-flash");
          st.flashTimer = 0;
          st.flashEl = null;
        }, 1500);
      }
    }

    return true;
  }

  return {
    ownSends,
    followOwnSend,
    keepBottom,
    setScrollTop,
    isNearBottom,
    isAtBottom,
    scrollToBottom,
    bottomGap,
    updateScrollToBottomBtn,
    updateJumpToPresentPill,
    scrollPage,
    setLoadingOlder,
    updateOlderFailedRow,
    retryOlder,
    lastSentId,
    fireOlderLoad,
    handleScroll,
    placeIndex,
    centreOnIndex,
    scrollToMessage,
    runIds,
    expandRunOf,
    toggleBlockedRun,
    revealIndex,
  };
}
