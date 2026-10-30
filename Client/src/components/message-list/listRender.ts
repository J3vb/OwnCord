/**
 * The message list's two render paths: a row-level patch for small store
 * changes, and a full rebuild that keeps the reader's place.
 */
import { getChannelMessages } from "@stores/messages.store";
import {
  buildVirtualItems,
  visibleMessages,
  type VirtualItem,
  type VirtualItemMessage,
} from "./virtualItems";
import { log, blockedUsers, focusSurvivingRow } from "./listShared";
import type { ListState, ListApi } from "./listState";

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
    if (st.root === null || st.contentContainer === null || st.tree === null) return false;
    if (st.renderAllRunning || st.renderedStart < 0 || st.allMessages.length === 0) return false;
    const nextParents = getChannelMessages(st.options.channelId);
    const next = visibleMessages(nextParents);
    if (next.length === 0) return false;
    const prevItems = st.virtualItems;
    const nextItems = buildVirtualItems(
      next,
      api.resolveNewDividerIndex(next),
      blockedUsers(),
      st.shownBlocked,
    );
    const prevKeys = prevItems.map(api.keyOf);
    const nextKeys = nextItems.map(api.keyOf);
    const prevIndex = new Map(prevKeys.map((k, i) => [k, i]));
    const nextIndex = new Map(nextKeys.map((k, i) => [k, i]));
    if (prevIndex.size < prevKeys.length || nextIndex.size < nextKeys.length) return false;

    // The rows that stay keep their order, and no message lands above every
    // message that stays (a history prepend sets `prepended`).
    let last = -1;
    let anchored = false;
    let prepended = false;
    for (const [j, item] of nextItems.entries()) {
      const i = prevIndex.get(nextKeys[j]!);
      if (i === undefined) {
        if (!anchored && item.kind === "message") prepended = true;
        continue;
      }
      if (i < last) return false;
      last = i;
      anchored ||= item.kind === "message";
    }
    if (!anchored) return false;

    // The new window spans what stays of the old one, grows with the tail when
    // it was at the tail, and keeps its top when it was at the top.
    let start = -1;
    let end = -1;
    for (let i = st.renderedStart; i < st.renderedEnd; i++) {
      const j = nextIndex.get(prevKeys[i]!);
      if (j === undefined) continue;
      if (start === -1) start = j;
      end = j + 1;
    }
    if (start === -1) return false;
    if (
      prepended &&
      !keepsRenderedRows(prevItems, prevKeys, prevIndex, nextKeys, nextIndex, start, end)
    ) {
      return false;
    }
    // A prepend's window stays on the rows already drawn; the page above it is
    // drawn by the slide below, as for any scroll.
    if (st.renderedStart === 0 && !prepended) start = 0;
    if (st.renderedEnd === prevItems.length) end = nextItems.length;
    if (end - start > MAX_INCREMENTAL_WINDOW) return false;

    // A newer history page landing below the reader is not a live arrival:
    // the reader keeps their place instead of being carried to the new bottom.
    const atBottom = api.keepBottom();
    // Record the rendered rows' heights under their current keys before the
    // items change, and the topmost visible message row that stays as the
    // anchor: a divider is no anchor, since the NEW line can move.
    api.measureRendered();
    let anchor = api.offsetToIndex(st.root.scrollTop);
    while (
      anchor < prevItems.length &&
      (prevItems[anchor]!.kind !== "message" || !nextIndex.has(prevKeys[anchor]!))
    ) {
      anchor++;
    }
    const anchorKey = prevKeys[anchor];
    const anchorOffset = st.root.scrollTop - api.offsetBefore(anchor);
    const anchorRow = prepended ? renderedRowAt(anchor) : undefined;
    const anchorEdge = anchorRow === undefined ? null : api.edgeOf(anchorRow);

    // A reply re-renders its quote when its parent left, arrived, or changed
    // what the quote draws (renderReplyRef reads the parent from replyParents);
    // a reaction or pin on the parent leaves the reply alone.
    const prevById = new Map(st.replyParents.map((m) => [m.id, m]));
    const nextById = new Map(nextParents.map((m) => [m.id, m]));
    const quoteChanged = (id: number | null): boolean => {
      if (id === null) return false;
      const a = prevById.get(id);
      const b = nextById.get(id);
      return a?.content !== b?.content || a?.deleted !== b?.deleted || a?.user !== b?.user;
    };

    const focused = api.captureRowFocus();
    const editHadFocus = api.editHoldsFocus();
    const prevStart = st.renderedStart;
    const prevEnd = st.renderedEnd;
    const shown = [...st.contentContainer.children] as HTMLElement[];
    // The row holding focus, so focus can move on if that row is removed.
    const focusedAt = shown.findIndex((el) => el.contains(document.activeElement));
    const focusedKey = focusedAt === -1 ? undefined : prevKeys[prevStart + focusedAt];
    const shownByKey = new Map(shown.map((el, i) => [prevKeys[st.renderedStart + i]!, el]));
    st.allMessages = next;
    st.replyParents = nextParents;
    st.virtualItems = nextItems;

    const rows: HTMLElement[] = [];
    const reused = new Set<HTMLElement>();
    for (let j = start; j < end; j++) {
      const now = nextItems[j]!;
      const el = shownByKey.get(nextKeys[j]!);
      const was = el && prevItems[prevIndex.get(nextKeys[j]!)!];
      // A row stays when nothing it draws changed: its message, its grouping
      // and the parent a reply quotes. A divider with the same key is the same.
      const same =
        now.kind === "blocked-run"
          ? was?.kind === "blocked-run" && was.count === now.count && was.expanded === now.expanded
          : now.kind !== "message" ||
            (was?.kind === "message" &&
              was.message === now.message &&
              was.isGrouped === now.isGrouped &&
              !quoteChanged(now.message.replyTo));
      if (el !== undefined && same) {
        rows.push(el);
        reused.add(el);
      } else {
        rows.push(api.renderVirtualItem(now));
      }
    }
    for (const el of shown) {
      if (!reused.has(el)) api.releaseRow(el);
    }
    // The reused rows are already in order; slot the new ones in around them.
    let cursor = st.contentContainer.firstElementChild;
    for (const el of rows) {
      if (el === cursor) cursor = cursor.nextElementSibling;
      else st.contentContainer.insertBefore(el, cursor);
    }
    st.renderedStart = start;
    st.renderedEnd = end;

    api.seedTree();
    api.measureRendered();
    api.updateSpacers();
    if (focused !== null && !st.contentContainer.contains(document.activeElement)) {
      if (!api.restoreRowFocus(focused) && focusedKey !== undefined && !nextIndex.has(focusedKey)) {
        // The focused row was removed (deleted): focus the next surviving row,
        // or the one before it, rather than dropping to <body>.
        focusSurvivingRow(prevKeys, nextIndex, rows, start, prevStart, prevEnd, focusedKey);
      }
    }

    if (atBottom) {
      api.scrollToBottom();
      if (prepended) api.renderWindow();
      api.updateScrollToBottomBtn();
    } else if (anchorKey === undefined) {
      if (prepended) api.renderWindow();
    } else {
      const anchorAt = nextIndex.get(anchorKey)!;
      api.setScrollTop(Math.max(0, api.offsetBefore(anchorAt) + anchorOffset));
      if (prepended) {
        // The page above is spacer only: draw the rows now in view, then
        // re-place the anchor against the heights they measured.
        api.renderWindow();
        for (let pass = 0; pass < 3; pass++) {
          if (!api.placeIndex(anchorAt, anchorOffset)) break;
        }
        const el = renderedRowAt(anchorAt);
        if (el !== undefined && anchorEdge !== null) api.holdRow(el, anchorEdge);
      }
    }
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

  function renderAll(hold?: { readonly key: string; readonly edge: number }): void {
    if (st.root === null) return;
    if (st.renderAllRunning) return; // prevent re-entrancy

    // Detect rapid-fire loops: if renderAll is called more than 20 times
    // within 2 seconds, something is wrong — bail out to prevent freeze.
    st.renderAllCount++;
    if (st.renderAllCount > 20) {
      log.error("[MessageList] renderAll called >20 times in 2s — breaking loop");
      st.renderAllSuppressed = true;
      return;
    }
    if (st.renderAllResetTimer === 0) {
      st.renderAllResetTimer = window.setTimeout(() => {
        st.renderAllCount = 0;
        st.renderAllResetTimer = 0;
        if (st.renderAllSuppressed) {
          // Render the burst's final state once, now that it's over.
          st.renderAllSuppressed = false;
          renderAll();
        }
      }, 2000);
    }

    st.renderAllRunning = true;
    const editHadFocus = api.editHoldsFocus();
    try {
      log.debug("renderAll START", { count: st.renderAllCount });
      st.wasAtBottom = api.keepBottom();

      // When scrolled away from the bottom, remember which message is
      // topmost in the viewport *before* rebuildItems() swaps virtualItems
      // out from under it. A history prepend (or any other non-append
      // rebuild) inserts or removes rows above/around the visible range
      // without touching scrollTop, so the unchanged pixel offset silently
      // ends up pointing at different content — most visibly, a "load
      // older" page landing and throwing the reader dozens of messages
      // backwards. Anchoring on the message's id rather than its index
      // survives the prepend, since the id is stable while the index shifts.
      let anchorMessageId: number | null = null;
      let anchorOffsetInItem = 0;
      let anchorEdge: number | null = null;
      if (!st.wasAtBottom && st.root !== null && hold === undefined) {
        const anchorIdx = topMessageIndex();
        if (anchorIdx !== -1) {
          anchorMessageId = (st.virtualItems[anchorIdx] as VirtualItemMessage).message.id;
          anchorOffsetInItem = st.root.scrollTop - api.offsetBefore(anchorIdx);
          const el = renderedRowAt(anchorIdx);
          if (el !== undefined) anchorEdge = api.edgeOf(el);
        }
      }

      api.rebuildItems();
      log.debug("renderAll rebuildItems done", { itemCount: st.virtualItems.length });

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
      if (st.wasAtBottom && st.root !== null) {
        const estTotal = api.totalHeight();
        if (st.topSpacer !== null) st.topSpacer.style.height = "0px";
        if (st.bottomSpacer !== null) st.bottomSpacer.style.height = `${estTotal}px`;
        api.setScrollTop(Math.max(0, estTotal - st.root.clientHeight));
      } else if (hold !== undefined && st.root !== null) {
        const at = st.virtualItems.findIndex((item, i) => api.keyOf(item, i) === hold.key);
        if (at !== -1) {
          const estTotal = api.totalHeight();
          if (st.topSpacer !== null) st.topSpacer.style.height = "0px";
          if (st.bottomSpacer !== null) st.bottomSpacer.style.height = `${estTotal}px`;
          api.setScrollTop(Math.max(0, api.offsetBefore(at) - hold.edge));
        }
      } else if (anchorMessageId !== null && st.root !== null) {
        const newIdx = st.virtualItems.findIndex(
          (item) => item.kind === "message" && item.message.id === anchorMessageId,
        );
        if (newIdx !== -1) {
          // Same clamping hazard as the bottom branch above: inflate the
          // spacers to the freshly rebuilt estimated total before assigning
          // scrollTop, so a prepend's larger offset is not silently clamped
          // back down to the stale (smaller) pre-rebuild scrollHeight.
          const estTotal = api.totalHeight();
          if (st.topSpacer !== null) st.topSpacer.style.height = "0px";
          if (st.bottomSpacer !== null) st.bottomSpacer.style.height = `${estTotal}px`;
          api.setScrollTop(Math.max(0, api.offsetBefore(newIdx) + anchorOffsetInItem));
        }
      }

      // Reset rendered range to force full re-render
      st.renderedStart = -1;
      st.renderedEnd = -1;

      api.renderWindow();
      log.debug("renderAll renderWindow done");

      // Correct scroll position with actual DOM measurements
      if (st.wasAtBottom) {
        api.scrollToBottom();
        api.updateScrollToBottomBtn();
      } else if (hold !== undefined) {
        const at = st.virtualItems.findIndex((item, i) => api.keyOf(item, i) === hold.key);
        if (at !== -1) {
          for (let pass = 0; pass < 3; pass++) {
            if (!api.placeIndex(at, -hold.edge)) break;
          }
          const el = renderedRowAt(at);
          if (el !== undefined) api.holdRow(el, hold.edge);
        }
      } else if (anchorMessageId !== null) {
        // The anchor above was applied against estimates for the rows the
        // rebuild put above the reader (a prepended page); renderWindow has
        // now measured the ones it built, so re-place the row and re-window
        // until it stays put, as scrollToMessage settles.
        const idx = st.virtualItems.findIndex(
          (item) => item.kind === "message" && item.message.id === anchorMessageId,
        );
        if (idx !== -1) {
          for (let pass = 0; pass < 3; pass++) {
            if (!api.placeIndex(idx, anchorOffsetInItem)) break;
          }
          // Then by its real edge: the rebuilt row is on screen now.
          const el = renderedRowAt(idx);
          if (el !== undefined && anchorEdge !== null) api.holdRow(el, anchorEdge);
        }
      }
      api.dropGoneEdit(editHadFocus);
      st.bottomGapBeforeResize = api.bottomGap();
      log.debug("renderAll END");
    } finally {
      st.renderAllRunning = false;
    }
  }

  return { keepsRenderedRows, patchRows, topMessageIndex, renderedRowAt, renderAll };
}
