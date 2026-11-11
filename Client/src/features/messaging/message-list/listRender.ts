/**
 * The message list's full rebuild path, which keeps the reader's place; the
 * row-level patch for small store changes lives in listPatch.
 */
import { log } from "./listShared";
import { keyOf, type VirtualItemMessage } from "./virtualItems";
import { createListPatch } from "./listPatch";
import type { ListState, ListApi } from "./listState";

export function createListRender(st: ListState, api: ListApi) {
  const { keepsRenderedRows, patchRows } = createListPatch(st, api, renderedRowAt);

  /** Index of the topmost message row in the viewport, or -1 when there is
   *  none that can be re-found after a rebuild. */
  function topMessageIndex(): number {
    if (st.root === null || st.virtualItems.length === 0) return -1;
    let idx = api.offsetToIndex(st.root.scrollTop);
    // The topmost item may be a day divider or the NEW divider, neither of
    // which has an identity that survives a rebuild — walk forward to the
    // message row that follows it (every divider is immediately followed by
    // one).
    while (idx < st.virtualItems.length && st.virtualItems[idx]!.kind !== "message") idx++;
    const item = st.virtualItems[idx];
    // id 0 is the unconfirmed-optimistic-row sentinel (see itemKey above) —
    // not unique across pending sends, so it cannot identify a specific row.
    return item?.kind === "message" && item.message.id !== 0 ? idx : -1;
  }

  function renderedRowAt(idx: number): Element | undefined {
    if (st.renderedStart < 0 || idx < st.renderedStart || idx >= st.renderedEnd) return undefined;
    return st.contentContainer?.children[idx - st.renderedStart];
  }

  /** The reader's place before a rebuild swaps the items out from under it. */
  interface ReaderAnchor {
    readonly id: number;
    readonly offset: number;
    readonly edge: number | null;
  }

  interface RowHold {
    readonly key: string;
    readonly edge: number;
  }

  /** Whether this call may rebuild: not re-entrant, and not part of a rapid-fire loop. */
  function admitRenderAll(): boolean {
    if (st.root === null) return false;
    if (st.renderAllRunning) return false; // prevent re-entrancy

    // Detect rapid-fire loops: if renderAll is called more than 20 times
    // within 2 seconds, something is wrong — bail out to prevent freeze.
    st.renderAllCount++;
    if (st.renderAllCount > 20) {
      log.error("[MessageList] renderAll called >20 times in 2s — breaking loop");
      st.renderAllSuppressed = true;
      return false;
    }
    if (st.renderAllResetTimer === 0) {
      st.renderAllResetTimer = window.setTimeout(endRenderAllBurst, 2000);
    }
    return true;
  }

  function endRenderAllBurst(): void {
    st.renderAllCount = 0;
    st.renderAllResetTimer = 0;
    if (st.renderAllSuppressed) {
      // Render the burst's final state once, now that it's over.
      st.renderAllSuppressed = false;
      renderAll();
    }
  }

  /**
   * When scrolled away from the bottom, remember which message is
   * topmost in the viewport *before* rebuildItems() swaps virtualItems
   * out from under it. A history prepend (or any other non-append
   * rebuild) inserts or removes rows above/around the visible range
   * without touching scrollTop, so the unchanged pixel offset silently
   * ends up pointing at different content — most visibly, a "load
   * older" page landing and throwing the reader dozens of messages
   * backwards. Anchoring on the message's id rather than its index
   * survives the prepend, since the id is stable while the index shifts.
   */
  function captureReaderAnchor(hold: RowHold | undefined): ReaderAnchor | null {
    if (st.wasAtBottom || st.root === null || hold !== undefined) return null;
    const anchorIdx = topMessageIndex();
    if (anchorIdx === -1) return null;
    const el = renderedRowAt(anchorIdx);
    return {
      id: (st.virtualItems[anchorIdx] as VirtualItemMessage).message.id,
      offset: st.root.scrollTop - api.offsetBefore(anchorIdx),
      edge: el === undefined ? null : api.edgeOf(el),
    };
  }

  /** Size the spacers for the whole estimated height and return it. The browser
   *  clamps scrollTop to (scrollHeight - clientHeight), so the spacers must be
   *  inflated BEFORE scrollTop is set. */
  function inflateSpacers(): number {
    const estTotal = api.totalHeight();
    if (st.topSpacer !== null) st.topSpacer.style.height = "0px";
    if (st.bottomSpacer !== null) st.bottomSpacer.style.height = `${estTotal}px`;
    return estTotal;
  }

  const indexOfKey = (key: string): number =>
    st.virtualItems.findIndex((item, i) => keyOf(item, i) === key);

  const indexOfMessage = (id: number): number =>
    st.virtualItems.findIndex((item) => item.kind === "message" && item.message.id === id);

  /** Pre-set the scroll position from estimated heights so renderWindow
   *  renders the range the reader is in. */
  function preplaceScroll(hold: RowHold | undefined, anchor: ReaderAnchor | null): void {
    const root = st.root;
    if (root === null) return;
    if (st.wasAtBottom) {
      // If user was at bottom, pre-set scroll position using estimated total
      // height so renderWindow renders the correct range for the bottom.
      // Without this, renderWindow renders from the top (range [0, N]) and
      // items near the bottom are never shown.
      //
      // IMPORTANT: inflate the spacers to the full estimated height BEFORE
      // setting scrollTop. The browser clamps scrollTop to
      // (scrollHeight - clientHeight), so if the spacers are still sized
      // from the previous (empty) render the assignment is silently ignored
      // and renderWindow renders from index 0 instead of the bottom.
      const estTotal = inflateSpacers();
      api.setScrollTop(Math.max(0, estTotal - root.clientHeight));
    } else if (hold !== undefined) {
      const at = indexOfKey(hold.key);
      if (at === -1) return;
      inflateSpacers();
      api.setScrollTop(Math.max(0, api.offsetBefore(at) - hold.edge));
    } else if (anchor !== null) {
      const newIdx = indexOfMessage(anchor.id);
      if (newIdx === -1) return;
      // Same clamping hazard as the bottom branch above: inflate the
      // spacers to the freshly rebuilt estimated total before assigning
      // scrollTop, so a prepend's larger offset is not silently clamped
      // back down to the stale (smaller) pre-rebuild scrollHeight.
      inflateSpacers();
      api.setScrollTop(Math.max(0, api.offsetBefore(newIdx) + anchor.offset));
    }
  }

  /** Re-place `at` until it stays put against the heights renderWindow measured. */
  function settleIndex(at: number, offset: number): void {
    for (let pass = 0; pass < 3; pass++) {
      if (!api.placeIndex(at, offset)) break;
    }
  }

  /** Correct the scroll position with actual DOM measurements. */
  function settleAfterRender(hold: RowHold | undefined, anchor: ReaderAnchor | null): void {
    if (st.wasAtBottom) {
      api.scrollToBottom();
      api.updateScrollToBottomBtn();
    } else if (hold !== undefined) {
      const at = indexOfKey(hold.key);
      if (at === -1) return;
      settleIndex(at, -hold.edge);
      const el = renderedRowAt(at);
      if (el !== undefined) api.holdRow(el, hold.edge);
    } else if (anchor !== null) {
      // The anchor above was applied against estimates for the rows the
      // rebuild put above the reader (a prepended page); renderWindow has
      // now measured the ones it built, so re-place the row and re-window
      // until it stays put, as scrollToMessage settles.
      const idx = indexOfMessage(anchor.id);
      if (idx === -1) return;
      settleIndex(idx, anchor.offset);
      // Then by its real edge: the rebuilt row is on screen now.
      const el = renderedRowAt(idx);
      if (el !== undefined && anchor.edge !== null) api.holdRow(el, anchor.edge);
    }
  }

  function rebuildAndPlace(hold: RowHold | undefined): void {
    log.debug("renderAll START", { count: st.renderAllCount });
    st.wasAtBottom = api.keepBottom();
    const anchor = captureReaderAnchor(hold);

    api.rebuildItems();
    log.debug("renderAll rebuildItems done", { itemCount: st.virtualItems.length });
    preplaceScroll(hold, anchor);

    // Reset rendered range to force full re-render
    st.renderedStart = -1;
    st.renderedEnd = -1;

    api.renderWindow();
    log.debug("renderAll renderWindow done");
    settleAfterRender(hold, anchor);
  }

  function renderAll(hold?: RowHold): void {
    if (!admitRenderAll()) return;

    st.renderAllRunning = true;
    const editHadFocus = api.editHoldsFocus();
    try {
      rebuildAndPlace(hold);
      api.dropGoneEdit(editHadFocus);
      st.bottomGapBeforeResize = api.bottomGap();
      log.debug("renderAll END");
    } finally {
      st.renderAllRunning = false;
    }
  }

  return { keepsRenderedRows, patchRows, topMessageIndex, renderedRowAt, renderAll };
}
