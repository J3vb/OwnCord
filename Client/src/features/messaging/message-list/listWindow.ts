/**
 * The message list's render window: which virtual items are drawn as rows,
 * their measured and estimated heights, and the spacers that stand in for the
 * rest.
 */
import { Disposable } from "@lib/disposable";
import { clearChildren } from "@lib/dom";
import {
  getChannelMessages,
  hasMoreMessages,
  getHistoryLoadState,
  type Message,
} from "@stores/messages.store";
import { discardMedia } from "../content/mediaVisibility";
import { renderBlockedRun, renderDayDivider, renderNewDivider, renderMessage } from "./renderers";
import { buildVirtualItems, visibleMessages, type VirtualItem } from "./virtualItems";
import { renderEmptyState, renderLoadErrorState, renderLoadingState } from "./listStates";
import { rememberRowHeight } from "./rowHeights";
import {
  log,
  blockedUsers,
  OVERSCAN_MAX_ROWS,
  OVERSCAN_VIEWPORTS,
  clampOverscan,
  type ScrollMetrics,
  readMetrics,
} from "./listShared";
import { resolveNewDividerIndex, storeDividerEnv } from "./newDivider";
import { createListHeights } from "./listHeights";
import { createRowFocus } from "./listFocus";
import { carryHoveredBar, ensureActionsBar } from "./messageActionBar";
import type { ListState, ListApi } from "./listState";

interface Measurement {
  readonly key: string;
  readonly idx: number;
  readonly h: number;
}

export function createListWindow(st: ListState, api: ListApi) {
  const dividerEnv = storeDividerEnv(st.options.channelId);
  const {
    itemKey,
    getItemHeight,
    rememberKey,
    estimateRow,
    totalHeight,
    offsetToIndex,
    offsetBefore,
    reseedUnmeasured,
    seedTree,
  } = createListHeights(st);
  const { captureRowFocus, restoreRowFocus } = createRowFocus(st);

  /** The NEW divider's position for a rebuild of `messages`. */
  function resolveDivider(messages: readonly Message[]): number {
    return resolveNewDividerIndex(st, messages, dividerEnv);
  }

  /** Render one virtual item — the single place the item kinds map to DOM. */
  function renderVirtualItem(item: VirtualItem): HTMLElement {
    if (item.kind === "divider") return renderDayDivider(item.timestamp);
    if (item.kind === "new-divider") return renderNewDivider();
    const owner = new Disposable();
    if (item.kind === "blocked-run") {
      const el = renderBlockedRun(item, () => api.toggleBlockedRun(item.firstId), owner.signal);
      st.rowOwners.set(el, owner);
      return el;
    }
    // The one editor node is re-hosted by every build of its row.
    const editor =
      st.edit !== null && st.edit.session !== null && st.edit.messageId === item.message.id
        ? st.edit.session.element
        : undefined;
    const el = renderMessage(
      item.message,
      item.isGrouped,
      st.replyParents,
      st.renderOptions,
      owner.signal,
      editor,
    );
    st.rowOwners.set(el, owner);
    if (item.message.id === st.replyTargetId && el.classList.contains("message")) {
      el.classList.add("reply-target");
    }
    if (st.fullBars) ensureActionsBar(el);
    return el;
  }

  /** Discard one rendered row: stop tracking its media and abort its listeners. */
  function releaseRow(el: HTMLElement): void {
    const editorEl = st.edit?.session?.element;
    if (editorEl !== undefined && el.contains(editorEl) && api.editHoldsFocus())
      st.editRefocus = true;
    for (const img of el.querySelectorAll("img")) discardMedia(img);
    st.rowOwners.get(el)?.destroy();
    st.rowOwners.delete(el);
    el.remove();
  }

  // ---------------------------------------------------------------------------
  // Render visible window
  // ---------------------------------------------------------------------------

  /** Record the heights of the rendered rows, or only those whose item index
   *  lies in [from, to) (a slide measures just the rows that entered; every
   *  other row was measured when it entered or by the ResizeObserver pass). */
  function measureRendered(from: number = st.renderedStart, to: number = st.renderedEnd): void {
    if (st.contentContainer === null || st.renderedStart < 0) return;
    // Pass 1 — pure reads: collect all heights without touching any styles.
    // Batching all getComputedStyle / offsetHeight reads before any writes
    // allows the browser to satisfy them with a single layout calculation
    // instead of forcing a synchronous reflow on every iteration.
    const measurements = readRowHeights(st.contentContainer, from, to);

    // The width these rows were laid out at, read with the heights (layout is
    // already clean): the observer may not have reported a resize yet.
    const measuredWidth = st.root?.clientWidth ?? 0;

    // Pass 2 — pure writes: apply all cached heights to heightCache and the
    // Fenwick tree. No DOM reads here, so no additional reflow is triggered.
    recordRowHeights(measurements, measuredWidth);
  }

  /** The rendered rows' heights, margins included, for item indexes in [from, to). */
  function readRowHeights(container: HTMLElement, from: number, to: number): Measurement[] {
    const children = container.children;
    const first = Math.max(0, from - st.renderedStart);
    const last = Math.min(children.length, to - st.renderedStart);
    const measurements: Measurement[] = [];
    for (let i = first; i < last; i++) {
      const globalIdx = st.renderedStart + i;
      if (globalIdx < 0 || (st.tree !== null && globalIdx >= st.tree.size)) continue;
      const el = children[i] as HTMLElement;
      const style = getComputedStyle(el);
      const h = el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      if (h > 0) {
        measurements.push({ key: itemKey(globalIdx), idx: globalIdx, h });
      }
    }
    return measurements;
  }

  function recordRowHeights(measurements: readonly Measurement[], measuredWidth: number): void {
    for (const { key, idx, h } of measurements) {
      st.heightCache.set(key, h);
      const shared = measuredWidth > 0 ? rememberKey(idx) : null;
      if (shared !== null) rememberRowHeight(shared, measuredWidth, h);
      if (st.tree !== null) {
        st.tree.set(idx, h);
      }
    }
  }

  function updateSpacers(): void {
    if (st.topSpacer !== null) {
      st.topSpacer.style.height = `${offsetBefore(st.renderedStart)}px`;
    }
    if (st.bottomSpacer !== null) {
      if (st.tree !== null) {
        const totalH = st.tree.total();
        const endOffset = st.renderedEnd > 0 ? st.tree.prefixSum(st.renderedEnd - 1) : 0;
        st.bottomSpacer.style.height = `${totalH - endOffset}px`;
      } else {
        let bh = 0;
        for (let i = st.renderedEnd; i < st.virtualItems.length; i++) bh += getItemHeight(i);
        st.bottomSpacer.style.height = `${bh}px`;
      }
    }
  }

  /** Release IntersectionObserver tracking, pending freeze timers, and frozen-
   *  frame data URLs for GIFs in rows that are about to be discarded — without
   *  this, media-visibility retains every <img> ever rendered. Must run before
   *  every clearChildren(contentContainer) and on destroy. */
  function releaseTrackedMedia(): void {
    if (st.contentContainer === null) return;
    for (const img of st.contentContainer.querySelectorAll("img")) {
      discardMedia(img);
    }
  }

  /** Abort every rendered row's listeners before a rebuild discards the rows,
   *  so a stale row can never outlive the render that replaced it.
   *  The row patch (patchRows) releases only the rows it replaces. */
  function beginRowRender(): void {
    for (const owner of st.rowOwners.values()) owner.destroy();
    st.rowOwners.clear();
  }

  /** Index of the message a recent jump is still centring, or -1. */
  function activeJumpIndex(): number {
    if (st.jumpTarget === null || Date.now() >= st.jumpTarget.until) return -1;
    const { messageId } = st.jumpTarget;
    return st.virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
  }

  /** Where `el`'s top edge sits in the scroller, in px below the top of the
   *  view; the one measure of position the heights model cannot drift from. */
  function edgeOf(el: Element): number {
    return st.root === null
      ? 0
      : el.getBoundingClientRect().top - st.root.getBoundingClientRect().top;
  }

  /** Scroll so `el`'s top edge is back at `edge` after rows above it were
   *  built, released or re-measured: a row that entered above the view
   *  measures differently from the estimate its spacer share was cut by, and
   *  a divider's collapsed margin never matches the summed one. */
  function holdRow(el: Element, edge: number): void {
    if (st.root === null) return;
    const delta = edgeOf(el) - edge;
    if (Math.abs(delta) >= 1) api.setScrollTop(st.root.scrollTop + delta);
  }

  /** Slide the rendered window to [start, end), which overlaps it: release the
   *  rows that left, render only the rows that entered, keep the rest. */
  function shiftWindow(
    start: number,
    end: number,
    view: Pick<ScrollMetrics, "scrollTop" | "clientHeight">,
  ): void {
    if (st.contentContainer === null) return;
    // Rows that stay were measured when they entered or by the ResizeObserver
    // pass, so only the rows that leave (here, before they are released: one
    // may have grown since the last pass) and the rows that enter (below) are
    // measured.
    const prevStart = st.renderedStart;
    const prevEnd = st.renderedEnd;
    measureRendered(prevStart, start);
    measureRendered(end, prevEnd);
    const rows = [...st.contentContainer.children] as HTMLElement[];
    // Rows entering above the view keep the first row that stays in place on
    // screen; rows leaving above it are measured, so their spacer share is exact.
    const kept = start < st.renderedStart ? rows[0] : undefined;
    const keptEdge = kept === undefined ? 0 : edgeOf(kept);
    // Only a row the reader could see is worth holding: a jump to the top
    // shows the rows above it instead, laid out as they really are.
    const hold = kept !== undefined && keptEdge < view.clientHeight && view.scrollTop > 0;
    for (let i = 0; i < rows.length; i++) {
      const globalIdx = st.renderedStart + i;
      if (globalIdx < start || globalIdx >= end) releaseRow(rows[i]!);
    }
    const head = document.createDocumentFragment();
    for (let i = start; i < st.renderedStart; i++) {
      head.appendChild(renderVirtualItem(st.virtualItems[i]!));
    }
    const tail = document.createDocumentFragment();
    for (let i = st.renderedEnd; i < end; i++) {
      tail.appendChild(renderVirtualItem(st.virtualItems[i]!));
    }
    st.contentContainer.insertBefore(head, st.contentContainer.firstChild);
    st.contentContainer.appendChild(tail);
    st.renderedStart = start;
    st.renderedEnd = end;
    measureRendered(start, prevStart);
    measureRendered(prevEnd, end);
    updateSpacers();
    if (hold && kept.isConnected) holdRow(kept, keptEdge);
    refocusEditor();
  }

  /** The row that held the focused editor is back: give the editor focus again,
   *  unless the reader has put it somewhere else meanwhile. */
  function refocusEditor(): void {
    const el = st.edit?.session?.element;
    if (!st.editRefocus || el === undefined || !el.isConnected) return;
    const active = document.activeElement;
    st.editRefocus = false;
    if (active !== null && active !== document.body) return;
    el.querySelector("textarea")?.focus({ preventScroll: true });
  }

  /** What an empty region shows: the fetch state's placeholder, an inline error
   *  + Retry, or the welcome/empty state (UX spec §1/§2). */
  function emptyRegionNode(
    loadState: "loading" | "error" | null,
    allDeleted: boolean,
    olderFailed: boolean,
  ): HTMLElement {
    if (olderFailed) {
      return renderLoadErrorState(() => {
        st.olderRetryAt = 0;
        renderWindow();
      });
    }
    if (loadState === "loading" || allDeleted) return renderLoadingState();
    if (loadState === "error") return renderLoadErrorState(st.options.onRetryLoad);
    return renderEmptyState(st.options.channelName, st.options.channelType);
  }

  /** No rows: clear the region and show the fetch state in it. */
  function renderEmptyRegion(content: HTMLElement, top: HTMLElement, bottom: HTMLElement): void {
    releaseTrackedMedia();
    beginRowRender();
    clearChildren(content);
    // With no rows, the region shows the fetch state: an in-region loading
    // placeholder, an inline error + Retry, or the welcome/empty state once
    // the channel is actually loaded and empty.
    const loadState = getHistoryLoadState(st.options.channelId);
    // Every loaded row was deleted but the server has older ones: not an
    // empty channel, so load the page before them instead of welcoming.
    const allDeleted =
      loadState === null &&
      getChannelMessages(st.options.channelId).length > 0 &&
      hasMoreMessages(st.options.channelId);
    // The page before them just failed to load: say so, with a retry,
    // instead of a placeholder that never ends.
    const olderFailed = allDeleted && !st.loadingOlder && performance.now() < st.olderRetryAt;
    content.appendChild(emptyRegionNode(loadState, allDeleted, olderFailed));
    st.loadedEmptyShown = loadState === null && !allDeleted;
    if (allDeleted && !st.loadingOlder && !olderFailed) api.fireOlderLoad();
    top.style.height = "0px";
    bottom.style.height = "0px";
    st.renderedStart = 0;
    st.renderedEnd = 0;
  }

  /** The item range [start, end) the viewport needs, overscan included. */
  function windowRangeFor(scrollTop: number, clientHeight: number): { start: number; end: number } {
    const firstVisible = offsetToIndex(scrollTop);
    const lastVisible = offsetToIndex(scrollTop + clientHeight);

    // Overscan is a distance, not a row count: a viewport above and below,
    // bounded to 4..20 rows each way so tall media rows do not pile up and
    // short rows keep a buffer. Without a viewport height, the row maximum.
    let above = OVERSCAN_MAX_ROWS;
    let below = OVERSCAN_MAX_ROWS;
    if (clientHeight > 0) {
      const margin = clientHeight * OVERSCAN_VIEWPORTS;
      above = clampOverscan(firstVisible - offsetToIndex(scrollTop - margin));
      below = clampOverscan(offsetToIndex(scrollTop + clientHeight + margin) - lastVisible);
    }
    let start = Math.max(0, firstVisible - above);
    const end = Math.min(st.virtualItems.length, lastVisible + below + 1);
    // A divider is drawn with the row under it: that row's top margin depends
    // on the divider being there, so a window starting between them would
    // measure the row differently from how it is laid out once both show.
    while (start > 0 && st.virtualItems[start - 1]!.kind !== "message") start--;
    return { start, end };
  }

  /** Count a DOM rebuild against the breaker; true when it must be skipped. */
  function rebuildSuppressed(): boolean {
    // Rate-limit DOM rebuilds only (expensive path).
    // Scroll-driven spacer updates are cheap and don't need limiting.
    st.renderWindowCount++;
    if (st.renderWindowCount > 30) {
      if (!st.renderWindowSuppressed) {
        log.error("[MessageList] renderWindow REBUILD called >30 times in 2s — breaking loop");
      }
      st.renderWindowSuppressed = true;
      return true;
    }
    if (st.renderWindowResetTimer === 0) {
      st.renderWindowResetTimer = window.setTimeout(() => {
        st.renderWindowCount = 0;
        st.renderWindowResetTimer = 0;
        if (st.renderWindowSuppressed) {
          st.renderWindowSuppressed = false;
          renderWindow();
        }
      }, 2000);
    }
    return false;
  }

  /** Full rebuild: requested by renderAll, or the window is following a
   *  scroll into a region that is not rendered yet. */
  function rebuildWindow(content: HTMLElement, start: number, end: number): void {
    log.debug("renderWindow REBUILD", { start, end });

    // Measure current elements before replacing.
    measureRendered();

    st.renderedStart = start;
    st.renderedEnd = end;

    // Rebuild content. The focused row's control is about to be detached by
    // clearChildren; capture its identity so it can be restored on its
    // replacement row (Q1: focus stays put through a virtualized rebuild).
    const focusedRow = captureRowFocus();
    const hovered = content.querySelector(".message:hover");
    if (api.editHoldsFocus()) st.editRefocus = true;
    releaseTrackedMedia();
    beginRowRender();
    clearChildren(content);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      fragment.appendChild(renderVirtualItem(st.virtualItems[i]!));
    }
    content.appendChild(fragment);
    carryHoveredBar(content, hovered);

    // Measure newly rendered elements and update spacers
    measureRendered();
    updateSpacers();
    restoreRowFocus(focusedRow);
    refocusEditor();
  }

  function renderWindow(m?: ScrollMetrics): void {
    if (
      st.root === null ||
      st.contentContainer === null ||
      st.topSpacer === null ||
      st.bottomSpacer === null
    )
      return;

    st.scrollSnapshot = null;
    const { scrollTop, clientHeight } = m ?? readMetrics(st.root);
    st.lastViewportHeight = clientHeight;

    if (st.virtualItems.length === 0) {
      renderEmptyRegion(st.contentContainer, st.topSpacer, st.bottomSpacer);
      return;
    }

    const { start, end } = windowRangeFor(scrollTop, clientHeight);

    // Rebuild the DOM when explicitly requested by renderAll (which sets
    // renderedStart to -1) or when the target range has left the rendered
    // window — scrolling past the overscan must materialize the rows the
    // spacers are standing in for. When the range is already fully rendered
    // this is a no-op, which (together with the rebuild rate limiter) prevents
    // the height oscillation loop where images loading → height change →
    // range recalculation → DOM rebuild → images reload → repeat. The
    // ResizeObserver handles measurement and spacer updates when element
    // sizes change; calling measureRendered + updateSpacers here would create
    // an infinite feedback loop:
    //   spacer change → scrollHeight change → scroll event → renderWindow
    //   → spacer change → ...
    if (st.renderedStart >= 0 && start >= st.renderedStart && end <= st.renderedEnd) return;
    // A scroll that only slides the window keeps the rows still in range and
    // builds just the ones entering it. It is cheap and never reloads a kept
    // row's media, so it neither consumes the rebuild breaker nor can
    // feed the height oscillation that breaker guards.
    if (
      st.renderedStart >= 0 &&
      start < st.renderedEnd &&
      end > st.renderedStart &&
      st.contentContainer.children.length === st.renderedEnd - st.renderedStart
    ) {
      shiftWindow(start, end, { scrollTop, clientHeight });
      return;
    }
    if (rebuildSuppressed()) return;
    rebuildWindow(st.contentContainer, start, end);
  }

  // ---------------------------------------------------------------------------
  // Full rebuild (on data change)
  // ---------------------------------------------------------------------------

  function rebuildItems(): void {
    st.replyParents = getChannelMessages(st.options.channelId);
    st.allMessages = visibleMessages(st.replyParents);
    st.virtualItems = buildVirtualItems(
      st.allMessages,
      resolveDivider(st.allMessages),
      blockedUsers(),
      st.shownBlocked,
    );

    seedTree();
  }
  return {
    resolveNewDividerIndex: resolveDivider,
    renderVirtualItem,
    releaseRow,
    itemKey,
    getItemHeight,
    rememberKey,
    estimateRow,
    totalHeight,
    offsetToIndex,
    offsetBefore,
    measureRendered,
    updateSpacers,
    releaseTrackedMedia,
    captureRowFocus,
    restoreRowFocus,
    beginRowRender,
    activeJumpIndex,
    edgeOf,
    holdRow,
    shiftWindow,
    refocusEditor,
    renderWindow,
    rebuildItems,
    reseedUnmeasured,
    seedTree,
  };
}
