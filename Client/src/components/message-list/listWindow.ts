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
  isWindowDetached,
  type Message,
} from "@stores/messages.store";
import { discardMedia } from "@lib/prefs/mediaVisibility";
import { renderBlockedRun, renderDayDivider, renderNewDivider, renderMessage } from "./renderers";
import { ROW_FOCUSABLE_SELECTOR } from "./messageActions";
import {
  buildVirtualItems,
  estimateItemHeight,
  firstUnreadIndex,
  visibleMessages,
  type VirtualItem,
} from "./virtualItems";
import { renderEmptyState, renderLoadErrorState, renderLoadingState } from "./listStates";
import { FenwickTree } from "./fenwick";
import { rememberRowHeight, rememberedRowHeight, rowHeightKey } from "./rowHeights";
import {
  log,
  blockedUsers,
  OVERSCAN_MAX_ROWS,
  OVERSCAN_VIEWPORTS,
  clampOverscan,
  type ScrollMetrics,
  readMetrics,
} from "./listShared";
import type { ListState, ListApi } from "./listState";

export function createListWindow(st: ListState, api: ListApi) {
  /**
   * Resolve the NEW divider's position for this rebuild. Prefers the latched
   * anchor id (stable across window growth); falls back to the count formula
   * only until an anchor exists, then latches it — skipping id 0 (an
   * unconfirmed optimistic row) since that id is not unique across pending
   * sends and would anchor to the wrong message once reconciled.
   *
   * Also skips latching while the window is shorter than unreadOnOpen: the
   * initial mount can render one live message before the async history
   * fetch resolves, and firstUnreadIndex's
   * `Math.max(0, ...)` clamp turns that 1-row window into index 0 just like a
   * real boundary would. Latching onto that message would glue the divider
   * to whatever happened to arrive first instead of the actual unread
   * boundary once the full window loads.
   */
  function resolveNewDividerIndex(messages: readonly Message[]): number {
    if (st.newDividerAnchorId !== null) {
      const at = messages.findIndex((m) => m.id === st.newDividerAnchorId);
      if (at === -1) {
        // The anchor was deleted (the store keeps it as a tombstone): the line
        // moves to the first message after it, or waits when there is none.
        const anchorId = st.newDividerAnchorId;
        const tombstone = getChannelMessages(st.options.channelId).some(
          (m) => m.id === anchorId && m.deleted,
        );
        if (tombstone) {
          const nextAt = messages.findIndex((m) => m.id > anchorId);
          if (nextAt === -1) return -1;
          st.newDividerAnchorId = messages[nextAt]!.id;
          return nextAt;
        }
      }
      if (at !== -1 || st.linePointer === undefined) return at;
      // The anchor left the window (a jump): place the line again by pointer.
      st.newDividerAnchorId = null;
    }
    // The first loaded message above the pointer, latched like the count-based
    // one — except at the top of the window, where older history may still
    // arrive above it and move the true boundary.
    const byPointer = (): number => {
      const idx = messages.findIndex((m) => m.id > (st.linePointer ?? 0));
      if (idx > 0) st.newDividerAnchorId = messages[idx]!.id;
      return idx;
    };
    // An around-window centred on a jumped-to message is not the tail: counting
    // back from its end would mark an arbitrary row. Detachment is read here,
    // not at mount, because a cross-channel jump detaches after the mount.
    if (isWindowDetached(st.options.channelId)) {
      st.newDividerDeferred = false;
      // No divider will exist to open at, and a pending open left armed would
      // scroll the reader up to the line once the tail returns.
      st.openAtDividerPending = false;
      // A pointer places the line inside the around-window too (never scrolled to).
      return st.linePointer === undefined ? -1 : byPointer();
    }
    // A revisit renders the cached window while its tail is refetched.
    // Those rows predate what arrived while away, so counting back from their
    // end would mark messages already read; wait for the fetched tail.
    st.newDividerDeferred =
      st.unreadOnOpen > 0 && getHistoryLoadState(st.options.channelId) === "loading";
    if (st.newDividerDeferred) return -1;
    if (st.linePointer !== undefined) {
      // Only a channel that had unread when opened: with none, the first message
      // above the pointer is just the first live arrival.
      return st.unreadOnOpen > 0 ? byPointer() : -1;
    }
    const idx = firstUnreadIndex(messages, st.unreadOnOpen);
    const anchor = idx !== -1 ? messages[idx] : undefined;
    if (anchor !== undefined && anchor.id !== 0 && messages.length >= st.unreadOnOpen) {
      st.newDividerAnchorId = anchor.id;
    }
    return idx;
  }

  // ---------------------------------------------------------------------------
  // Height estimation (Fenwick tree backed)
  // ---------------------------------------------------------------------------

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

  function itemKey(index: number): string {
    return keyOf(st.virtualItems[index], index);
  }

  function keyOf(item: VirtualItem | undefined, index: number): string {
    if (item === undefined) return `idx-${index}`;
    if (item.kind === "divider") return `div-${item.timestamp}`;
    if (item.kind === "new-divider") return "new-divider";
    if (item.kind === "blocked-run") return `blk-${item.firstId}`;
    // Every unconfirmed optimistic row (addOptimisticMessage) carries
    // id: 0 until confirmSend stamps the real id, so keying purely on
    // message.id would collide two or more pending rows onto the same
    // "msg-0" cache entry — measureRendered would overwrite one row's
    // measured height with another's, and the next Fenwick rebuild
    // (rebuildItems / patchRows) would seed both rows' tree slots
    // from that single, wrong value. correlationId is unique per pending
    // send and stable across the row's lifetime, so key on that instead
    // while id is still the 0 sentinel; fall back to the row's own index
    // in the vanishingly unlikely case correlationId is also absent.
    if (item.message.id === 0) {
      return item.message.correlationId !== null
        ? `msg-c-${item.message.correlationId}`
        : `idx-${index}`;
    }
    return `msg-${item.message.id}`;
  }

  function getItemHeight(index: number): number {
    const cached = st.heightCache.get(itemKey(index));
    if (cached !== undefined) return cached;
    return estimateRow(index);
  }

  /** A message row's height key across lists; null for rows that are not a
   *  confirmed message. */
  function rememberKey(index: number): string | null {
    const item = st.virtualItems[index];
    if (item === undefined || item.kind !== "message" || item.message.id === 0) return null;
    return rowHeightKey(item.message.id, item.isGrouped, item.message.editedAt);
  }

  /** An unmeasured row: the height an earlier list of this channel drew it at,
   *  else the estimate. */
  function estimateRow(index: number): number {
    const key = st.estimateWidth === undefined ? null : rememberKey(index);
    const remembered = key === null ? undefined : rememberedRowHeight(key, st.estimateWidth!);
    return remembered ?? estimateItemHeight(st.virtualItems[index]!, st.estimateWidth);
  }

  function totalHeight(): number {
    if (st.tree !== null) return st.tree.total();
    let h = 0;
    for (let i = 0; i < st.virtualItems.length; i++) {
      h += getItemHeight(i);
    }
    return h;
  }

  function offsetToIndex(scrollTop: number): number {
    if (st.tree !== null) return st.tree.findIndex(scrollTop);
    let offset = 0;
    for (let i = 0; i < st.virtualItems.length; i++) {
      const h = getItemHeight(i);
      if (offset + h > scrollTop) return i;
      offset += h;
    }
    return st.virtualItems.length - 1;
  }

  function offsetBefore(index: number): number {
    if (st.tree !== null && index > 0) return st.tree.prefixSum(index - 1);
    if (st.tree !== null && index <= 0) return 0;
    let offset = 0;
    for (let i = 0; i < index && i < st.virtualItems.length; i++) {
      offset += getItemHeight(i);
    }
    return offset;
  }

  // ---------------------------------------------------------------------------
  // Render visible window
  // ---------------------------------------------------------------------------

  /** Record the heights of the rendered rows, or only those whose item index
   *  lies in [from, to) (a slide measures just the rows that entered; every
   *  other row was measured when it entered or by the ResizeObserver pass). */
  function measureRendered(from: number = st.renderedStart, to: number = st.renderedEnd): void {
    if (st.contentContainer === null || st.renderedStart < 0) return;
    const children = st.contentContainer.children;
    const first = Math.max(0, from - st.renderedStart);
    const last = Math.min(children.length, to - st.renderedStart);

    // Pass 1 — pure reads: collect all heights without touching any styles.
    // Batching all getComputedStyle / offsetHeight reads before any writes
    // allows the browser to satisfy them with a single layout calculation
    // instead of forcing a synchronous reflow on every iteration.
    interface Measurement {
      readonly key: string;
      readonly idx: number;
      readonly h: number;
    }
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

    // The width these rows were laid out at, read with the heights (layout is
    // already clean): the observer may not have reported a resize yet.
    const measuredWidth = st.root?.clientWidth ?? 0;

    // Pass 2 — pure writes: apply all cached heights to heightCache and the
    // Fenwick tree. No DOM reads here, so no additional reflow is triggered.
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

  /**
   * Stable identity of the focused control inside the rendered window, so a
   * virtualized rebuild can put focus back on its replacement (Q1 focus:
   * stable location through async update/removal). The row's own key survives
   * the rebuild because rows are keyed by message id; a control with its own
   * `data-testid` (the action buttons) is restored exactly, and a focusable
   * without one (a reaction chip, a reply bar, a link) is restored by its
   * position among the row's focusable controls. Null when focus is outside
   * the rendered window, so an unrelated rebuild never pulls focus back into
   * the list. Restoring never scrolls, so a reader scrolling away from the
   * focused row or a history-prepend anchor is not pulled back to it.
   */
  function captureRowFocus(): { own: string | null; row: string | null; index: number } | null {
    const active = document.activeElement;
    if (
      !(active instanceof HTMLElement) ||
      st.contentContainer === null ||
      !st.contentContainer.contains(active)
    ) {
      return null;
    }
    const row = active.closest<HTMLElement>("[data-testid]");
    const index =
      row === null ? -1 : [...row.querySelectorAll(ROW_FOCUSABLE_SELECTOR)].indexOf(active);
    return { own: active.dataset.testid ?? null, row: row?.dataset.testid ?? null, index };
  }

  /** Put focus back on the captured control's replacement; false when it has none. */
  function restoreRowFocus(
    captured: { own: string | null; row: string | null; index: number } | null,
  ): boolean {
    if (captured === null || st.contentContainer === null) return false;
    let target: HTMLElement | null | undefined = null;
    if (captured.own !== null) {
      target = st.contentContainer.querySelector<HTMLElement>(`[data-testid="${captured.own}"]`);
    } else if (captured.row !== null && captured.index >= 0) {
      target = st.contentContainer
        .querySelector<HTMLElement>(`[data-testid="${captured.row}"]`)
        ?.querySelectorAll<HTMLElement>(ROW_FOCUSABLE_SELECTOR)
        .item(captured.index);
    }
    target?.focus({ preventScroll: true });
    return target !== null && target !== undefined;
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
      releaseTrackedMedia();
      beginRowRender();
      clearChildren(st.contentContainer);
      // With no rows, the region shows the fetch state: an in-region loading
      // placeholder, an inline error + Retry, or the welcome/empty state once
      // the channel is actually loaded and empty (UX spec §1/§2).
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
      if (olderFailed) {
        st.contentContainer.appendChild(
          renderLoadErrorState(() => {
            st.olderRetryAt = 0;
            renderWindow();
          }),
        );
      } else if (loadState === "loading" || allDeleted) {
        st.contentContainer.appendChild(renderLoadingState());
      } else if (loadState === "error") {
        st.contentContainer.appendChild(renderLoadErrorState(st.options.onRetryLoad));
      } else {
        st.contentContainer.appendChild(
          renderEmptyState(st.options.channelName, st.options.channelType),
        );
      }
      st.loadedEmptyShown = loadState === null && !allDeleted;
      if (allDeleted && !st.loadingOlder && !olderFailed) api.fireOlderLoad();
      st.topSpacer.style.height = "0px";
      st.bottomSpacer.style.height = "0px";
      st.renderedStart = 0;
      st.renderedEnd = 0;
      return;
    }

    // Determine visible range
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

    // Rebuild the DOM when explicitly requested by renderAll (which sets
    // renderedStart to -1) or when the target range has left the rendered
    // window — scrolling past the overscan must materialize the rows the
    // spacers are standing in for. When the range is already fully rendered
    // this is a no-op, which (together with the rebuild rate limiter below)
    // prevents the height oscillation loop where images loading → height
    // change → range recalculation → DOM rebuild → images reload → repeat.
    const rangeAlreadyRendered =
      st.renderedStart >= 0 && start >= st.renderedStart && end <= st.renderedEnd;
    // A scroll that only slides the window keeps the rows still in range and
    // builds just the ones entering it. It is cheap and never reloads a kept
    // row's media, so it neither consumes the rebuild breaker below nor can
    // feed the height oscillation that breaker guards.
    if (
      !rangeAlreadyRendered &&
      st.renderedStart >= 0 &&
      start < st.renderedEnd &&
      end > st.renderedStart &&
      st.contentContainer.children.length === st.renderedEnd - st.renderedStart
    ) {
      shiftWindow(start, end, { scrollTop, clientHeight });
      return;
    }
    if (!rangeAlreadyRendered) {
      // Rate-limit DOM rebuilds only (expensive path).
      // Scroll-driven spacer updates are cheap and don't need limiting.
      st.renderWindowCount++;
      if (st.renderWindowCount > 30) {
        if (!st.renderWindowSuppressed) {
          log.error("[MessageList] renderWindow REBUILD called >30 times in 2s — breaking loop");
        }
        st.renderWindowSuppressed = true;
        return;
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

      // Full rebuild: requested by renderAll, or the window is following a
      // scroll into a region that is not rendered yet.
      log.debug("renderWindow REBUILD", { start, end });

      // Measure current elements before replacing.
      measureRendered();

      st.renderedStart = start;
      st.renderedEnd = end;

      // Rebuild content. The focused row's control is about to be detached by
      // clearChildren; capture its identity so it can be restored on its
      // replacement row (Q1: focus stays put through a virtualized rebuild).
      const focusedRow = captureRowFocus();
      if (api.editHoldsFocus()) st.editRefocus = true;
      releaseTrackedMedia();
      beginRowRender();
      clearChildren(st.contentContainer);
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        fragment.appendChild(renderVirtualItem(st.virtualItems[i]!));
      }
      st.contentContainer.appendChild(fragment);

      // Measure newly rendered elements and update spacers
      measureRendered();
      updateSpacers();
      restoreRowFocus(focusedRow);
      refocusEditor();
    } else {
      // Target range already fully rendered: no-op. The ResizeObserver
      // handles measurement and spacer updates when element sizes change.
      // Calling measureRendered + updateSpacers here creates an infinite
      // feedback loop:
      //   spacer change → scrollHeight change → scroll event → renderWindow
      //   → spacer change → ...
    }
  }

  // ---------------------------------------------------------------------------
  // Full rebuild (on data change)
  // ---------------------------------------------------------------------------

  function rebuildItems(): void {
    st.replyParents = getChannelMessages(st.options.channelId);
    st.allMessages = visibleMessages(st.replyParents);
    st.virtualItems = buildVirtualItems(
      st.allMessages,
      resolveNewDividerIndex(st.allMessages),
      blockedUsers(),
      st.shownBlocked,
    );

    seedTree();
  }

  /** Estimate again every row that has no measured height, leaving measured
   *  rows (and so the rendered window) as they are. */
  function reseedUnmeasured(): void {
    if (st.tree === null) return;
    for (let i = 0; i < st.virtualItems.length; i++) {
      if (!st.heightCache.has(itemKey(i))) st.tree.set(i, estimateRow(i));
    }
  }

  /** Build the Fenwick tree from measured heights, estimating the rest. */
  function seedTree(): void {
    st.tree = new FenwickTree(st.virtualItems.length);
    for (let i = 0; i < st.virtualItems.length; i++) st.tree.set(i, getItemHeight(i));
  }

  return {
    resolveNewDividerIndex,
    renderVirtualItem,
    releaseRow,
    itemKey,
    keyOf,
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
