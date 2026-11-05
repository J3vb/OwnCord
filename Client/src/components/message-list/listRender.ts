/**
 * The message list's two render paths: a row-level patch for small store
 * changes, and a full rebuild that keeps the reader's place.
 */
import { getChannelMessages, type Message } from "@stores/messages.store";
import {
  buildVirtualItems,
  keyOf,
  visibleMessages,
  type VirtualItem,
  type VirtualItemMessage,
} from "./virtualItems";
import { log, blockedUsers, focusSurvivingRow } from "./listShared";
import type { ListState, ListApi } from "./listState";

/** What a patch decided from diffing the store's rows against the rendered ones. */
interface PatchPlan {
  readonly nextParents: readonly Message[];
  readonly next: readonly Message[];
  readonly prevItems: readonly VirtualItem[];
  readonly nextItems: readonly VirtualItem[];
  readonly prevKeys: readonly string[];
  readonly nextKeys: readonly string[];
  readonly prevIndex: ReadonlyMap<string, number>;
  readonly nextIndex: ReadonlyMap<string, number>;
  /** A page landed above every row that stays. */
  readonly prepended: boolean;
  readonly start: number;
  readonly end: number;
}

/**
 * Whether the rows that stay keep their order, and no message lands above
 * every message that stays (a history prepend sets `prepended`). Null when
 * the order broke or no message stays.
 */
function stayingRowOrder(
  nextItems: readonly VirtualItem[],
  nextKeys: readonly string[],
  prevIndex: ReadonlyMap<string, number>,
): { prepended: boolean } | null {
  let last = -1;
  let anchored = false;
  let prepended = false;
  for (const [j, item] of nextItems.entries()) {
    const i = prevIndex.get(nextKeys[j]!);
    if (i === undefined) {
      if (!anchored && item.kind === "message") prepended = true;
      continue;
    }
    if (i < last) return null;
    last = i;
    anchored ||= item.kind === "message";
  }
  return anchored ? { prepended } : null;
}

/**
 * A row stays when nothing it draws changed: its message, its grouping and the
 * parent a reply quotes. A divider with the same key is the same.
 */
function rowStays(
  now: VirtualItem,
  was: VirtualItem | undefined,
  quoteChanged: (id: number | null) => boolean,
): boolean {
  if (now.kind === "blocked-run") {
    return was?.kind === "blocked-run" && was.count === now.count && was.expanded === now.expanded;
  }
  if (now.kind !== "message") return true;
  return (
    was?.kind === "message" &&
    was.message === now.message &&
    was.isGrouped === now.isGrouped &&
    !quoteChanged(now.message.replyTo)
  );
}

/**
 * A reply re-renders its quote when its parent left, arrived, or changed what
 * the quote draws (renderReplyRef reads the parent from replyParents); a
 * reaction or pin on the parent leaves the reply alone.
 */
function replyQuoteChanged(
  prevParents: readonly Message[],
  nextParents: readonly Message[],
): (id: number | null) => boolean {
  const prevById = new Map(prevParents.map((m) => [m.id, m]));
  const nextById = new Map(nextParents.map((m) => [m.id, m]));
  return (id) => {
    if (id === null) return false;
    const a = prevById.get(id);
    const b = nextById.get(id);
    return a?.content !== b?.content || a?.deleted !== b?.deleted || a?.user !== b?.user;
  };
}

export function createListRender(st: ListState, api: ListApi) {
  // ---------------------------------------------------------------------------
  // Row-level patch (fast path)
  // ---------------------------------------------------------------------------

  /** Cap on rendered rows for the patch path. Once the window grows past
   *  this, fall back to renderAll so it is re-trimmed to the visible range. */
  const MAX_INCREMENTAL_WINDOW = 200;

  /**
   * Whether a history prepend leaves every rendered row in place: each item of
   * the new window [start, end) was a rendered row, and each rendered row is
   * in it, bar day dividers at its head (the day now starts higher up).
   */
  function keepsRenderedRows(
    prevItems: readonly VirtualItem[],
    prevKeys: readonly string[],
    prevIndex: ReadonlyMap<string, number>,
    nextKeys: readonly string[],
    nextIndex: ReadonlyMap<string, number>,
    start: number,
    end: number,
  ): boolean {
    for (let j = start; j < end; j++) {
      const i = prevIndex.get(nextKeys[j]!);
      if (i === undefined || i < st.renderedStart || i >= st.renderedEnd) return false;
    }
    let atHead = true;
    for (let i = st.renderedStart; i < st.renderedEnd; i++) {
      if (nextIndex.has(prevKeys[i]!)) {
        atHead = false;
      } else if (!atHead || prevItems[i]!.kind !== "divider") {
        return false;
      }
    }
    return true;
  }

  /** Diff the store's rows against the rendered ones: null when the patch path
   *  cannot keep the DOM and renderAll must rebuild. */
  function planPatch(): PatchPlan | null {
    const nextParents = getChannelMessages(st.options.channelId);
    const next = visibleMessages(nextParents);
    if (next.length === 0) return null;
    const prevItems = st.virtualItems;
    const nextItems = buildVirtualItems(
      next,
      api.resolveNewDividerIndex(next),
      blockedUsers(),
      st.shownBlocked,
    );
    const prevKeys = prevItems.map(keyOf);
    const nextKeys = nextItems.map(keyOf);
    const prevIndex = new Map(prevKeys.map((k, i) => [k, i]));
    const nextIndex = new Map(nextKeys.map((k, i) => [k, i]));
    if (prevIndex.size < prevKeys.length || nextIndex.size < nextKeys.length) return null;

    const order = stayingRowOrder(nextItems, nextKeys, prevIndex);
    if (order === null) return null;
    const { prepended } = order;
    const span = survivingSpan(prevKeys, nextIndex);
    if (span === null) return null;
    if (
      prepended &&
      !keepsRenderedRows(prevItems, prevKeys, prevIndex, nextKeys, nextIndex, span.start, span.end)
    ) {
      return null;
    }
    const win = patchedWindow(span, prepended, prevItems.length, nextItems.length);
    if (win === null) return null;
    return {
      nextParents,
      next,
      prevItems,
      nextItems,
      prevKeys,
      nextKeys,
      prevIndex,
      nextIndex,
      prepended,
      start: win.start,
      end: win.end,
    };
  }

  /** The new window spans what stays of the old one. */
  function survivingSpan(
    prevKeys: readonly string[],
    nextIndex: ReadonlyMap<string, number>,
  ): { start: number; end: number } | null {
    let start = -1;
    let end = -1;
    for (let i = st.renderedStart; i < st.renderedEnd; i++) {
      const j = nextIndex.get(prevKeys[i]!);
      if (j === undefined) continue;
      if (start === -1) start = j;
      end = j + 1;
    }
    return start === -1 ? null : { start, end };
  }

  /** The window grows with the tail when it was at the tail, and keeps its top
   *  when it was at the top; null when it outgrew the patch path. */
  function patchedWindow(
    span: { start: number; end: number },
    prepended: boolean,
    prevLength: number,
    nextLength: number,
  ): { start: number; end: number } | null {
    let { start, end } = span;
    // A prepend's window stays on the rows already drawn; the page above it is
    // drawn by the slide below, as for any scroll.
    if (st.renderedStart === 0 && !prepended) start = 0;
    if (st.renderedEnd === prevLength) end = nextLength;
    return end - start > MAX_INCREMENTAL_WINDOW ? null : { start, end };
  }

  /** Index of the topmost visible message row that stays: a divider is no
   *  anchor, since the NEW line can move. */
  function topStayingMessage(
    root: HTMLElement,
    prevItems: readonly VirtualItem[],
    prevKeys: readonly string[],
    nextIndex: ReadonlyMap<string, number>,
  ): number {
    let anchor = api.offsetToIndex(root.scrollTop);
    while (
      anchor < prevItems.length &&
      (prevItems[anchor]!.kind !== "message" || !nextIndex.has(prevKeys[anchor]!))
    ) {
      anchor++;
    }
    return anchor;
  }

  /** Render the rows [start, end) of the new items, reusing the node of each
   *  row that drew nothing different. */
  function buildPatchedRows(
    plan: PatchPlan,
    shownByKey: ReadonlyMap<string, HTMLElement>,
    quoteChanged: (id: number | null) => boolean,
  ): { rows: HTMLElement[]; reused: Set<HTMLElement> } {
    const rows: HTMLElement[] = [];
    const reused = new Set<HTMLElement>();
    for (let j = plan.start; j < plan.end; j++) {
      const now = plan.nextItems[j]!;
      const el = shownByKey.get(plan.nextKeys[j]!);
      const was =
        el === undefined ? undefined : plan.prevItems[plan.prevIndex.get(plan.nextKeys[j]!)!];
      if (el !== undefined && rowStays(now, was, quoteChanged)) {
        rows.push(el);
        reused.add(el);
      } else {
        rows.push(api.renderVirtualItem(now));
      }
    }
    return { rows, reused };
  }

  /** Release the rows that were not reused, then slot the new ones in around
   *  the reused rows, which are already in order. */
  function swapRows(
    container: HTMLElement,
    shown: readonly HTMLElement[],
    rows: readonly HTMLElement[],
    reused: ReadonlySet<HTMLElement>,
  ): void {
    for (const el of shown) {
      if (!reused.has(el)) api.releaseRow(el);
    }
    let cursor = container.firstElementChild;
    for (const el of rows) {
      if (el === cursor) cursor = cursor.nextElementSibling;
      else container.insertBefore(el, cursor);
    }
  }

  /** Put focus back after the patch: on the control it was on, or, when its
   *  row was removed (deleted), on the next surviving row or the one before it,
   *  rather than dropping to <body>. */
  function restorePatchFocus(
    container: HTMLElement,
    focused: ReturnType<ListApi["captureRowFocus"]>,
    focusedKey: string | undefined,
    plan: PatchPlan,
    rows: readonly HTMLElement[],
    prevStart: number,
    prevEnd: number,
  ): void {
    if (focused === null || container.contains(document.activeElement)) return;
    if (api.restoreRowFocus(focused)) return;
    if (focusedKey !== undefined && !plan.nextIndex.has(focusedKey)) {
      focusSurvivingRow(
        plan.prevKeys,
        plan.nextIndex,
        rows,
        plan.start,
        prevStart,
        prevEnd,
        focusedKey,
      );
    }
  }

  /** Where the reader ends up: at the bottom, or on the row they were reading. */
  function settlePatchScroll(
    plan: PatchPlan,
    atBottom: boolean,
    anchorKey: string | undefined,
    anchorOffset: number,
    anchorEdge: number | null,
  ): void {
    if (atBottom) {
      api.scrollToBottom();
      if (plan.prepended) api.renderWindow();
      api.updateScrollToBottomBtn();
      return;
    }
    if (anchorKey === undefined) {
      if (plan.prepended) api.renderWindow();
      return;
    }
    const anchorAt = plan.nextIndex.get(anchorKey)!;
    api.setScrollTop(Math.max(0, api.offsetBefore(anchorAt) + anchorOffset));
    if (!plan.prepended) return;
    // The page above is spacer only: draw the rows now in view, then
    // re-place the anchor against the heights they measured.
    api.renderWindow();
    for (let pass = 0; pass < 3; pass++) {
      if (!api.placeIndex(anchorAt, anchorOffset)) break;
    }
    const el = renderedRowAt(anchorAt);
    if (el !== undefined && anchorEdge !== null) api.holdRow(el, anchorEdge);
  }

  /**
   * Fast path for a store update that changes a few rows: diff the new
   * items against the rendered ones by key and touch only what changed — a
   * reaction, edit, delete or send confirmation re-renders its own row, plus a
   * neighbour whose grouping changed and any loaded reply whose quoted
   * parent arrived, left or changed text, author or deletion. Rows dropped from the head, rows appended at the tail (a
   * revisit's refetched page, R1) and the NEW divider landing (R2) are
   * inserted or removed one by one. Every other row keeps its DOM node, so a
   * playing video, a revealed spoiler or focus survive. A row outside the
   * rendered window only moves its height entry.
   *
   * A history prepend keeps the DOM too, when every rendered row survives
   * (a day divider that moved up with the page excepted) and the new items all
   * land above the rendered window, the tail trim of the message cap included:
   * the window's indices shift by the inserted count, the spacers take the
   * page's estimated height and the reading position is re-applied in the same
   * task, so no rendered row is rebuilt or has its media reloaded. A prepend
   * that moves the NEW line, reaches into the window or drops a rendered row
   * is left to renderAll.
   *
   * Returns false, for renderAll to rebuild, when there is nothing rendered to
   * keep, rows were reordered, or a message was inserted above every row that
   * stays and the prepend conditions above do not hold.
   *
   * The Fenwick tree is re-seeded from the height cache, as for any rebuild,
   * and the topmost visible message row that stays keeps its offset in the
   * viewport. The renderWindow oscillation guard is not consumed — this path
   * never rebuilds.
   */
  function patchRows(): boolean {
    const root = st.root;
    const container = st.contentContainer;
    if (root === null || container === null || st.tree === null) return false;
    if (st.renderAllRunning || st.renderedStart < 0 || st.allMessages.length === 0) return false;
    const plan = planPatch();
    if (plan === null) return false;
    const { prevItems, prevKeys, nextIndex, nextParents, prepended } = plan;

    // A newer history page landing below the reader is not a live arrival:
    // the reader keeps their place instead of being carried to the new bottom.
    const atBottom = api.keepBottom();
    // Record the rendered rows' heights under their current keys before the
    // items change, and the topmost visible message row that stays as the
    // anchor.
    api.measureRendered();
    const anchor = topStayingMessage(root, prevItems, prevKeys, nextIndex);
    const anchorKey = prevKeys[anchor];
    const anchorOffset = root.scrollTop - api.offsetBefore(anchor);
    const anchorRow = prepended ? renderedRowAt(anchor) : undefined;
    const anchorEdge = anchorRow === undefined ? null : api.edgeOf(anchorRow);

    const quoteChanged = replyQuoteChanged(st.replyParents, nextParents);
    const focused = api.captureRowFocus();
    const editHadFocus = api.editHoldsFocus();
    const prevStart = st.renderedStart;
    const prevEnd = st.renderedEnd;
    const shown = [...container.children] as HTMLElement[];
    // The row holding focus, so focus can move on if that row is removed.
    const focusedAt = shown.findIndex((el) => el.contains(document.activeElement));
    const focusedKey = focusedAt === -1 ? undefined : prevKeys[prevStart + focusedAt];
    const shownByKey = new Map(shown.map((el, i) => [prevKeys[st.renderedStart + i]!, el]));
    st.allMessages = plan.next;
    st.replyParents = nextParents;
    st.virtualItems = plan.nextItems;

    const { rows, reused } = buildPatchedRows(plan, shownByKey, quoteChanged);
    swapRows(container, shown, rows, reused);
    st.renderedStart = plan.start;
    st.renderedEnd = plan.end;

    api.seedTree();
    api.measureRendered();
    api.updateSpacers();
    restorePatchFocus(container, focused, focusedKey, plan, rows, prevStart, prevEnd);
    settlePatchScroll(plan, atBottom, anchorKey, anchorOffset, anchorEdge);
    api.dropGoneEdit(editHadFocus);
    // The rows changed under the reader without a scroll event: a newer page
    // landing below a reader near the bottom of a detached window leaves them
    // where they were, so the resize pass must not pull them down to it.
    st.bottomGapBeforeResize = api.bottomGap();
    return true;
  }

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
