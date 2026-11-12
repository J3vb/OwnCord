/**
 * The message list's resize handling: a ResizeObserver over the content and
 * the scroller that re-measures rendered rows and holds the reader's reading
 * position (or the bottom) while rows change height.
 */
import { SCROLL_BOTTOM_THRESHOLD, readMetrics } from "./listShared";
import type { ListState, ListApi } from "./listState";
import type { ListDom } from "./listDom";

export function observeListResize(st: ListState, api: ListApi, dom: ListDom): void {
  const { root, content } = dom;

  // Watch for height changes in rendered items (images loading, embeds expanding).
  // A plain re-measure runs inside the observer callback, which comes after
  // layout and before paint: deferring it to the next frame painted one frame
  // with the rows below a grown image or card shifted, then snapped them back.
  // A pass that may build rows (a resized viewport, a jump settling, the NEW
  // divider still to place) resizes the observed content itself, so it waits
  // for the next frame instead of looping the observer.
  const firstRowStartingInView = (scrollTop: number, clientHeight: number): number => {
    const idx = api.offsetToIndex(scrollTop);
    const startsAbove = api.offsetBefore(idx) < scrollTop;
    const nextInView =
      idx + 1 < st.renderedEnd && api.offsetBefore(idx + 1) < scrollTop + clientHeight;
    return startsAbove && nextInView ? idx + 1 : idx;
  };
  const resizePass = (): void => {
    if (st.root === null || st.contentContainer === null) return;
    // The text estimates wrap at the list's width: when it changes, the
    // rows nothing has measured yet are estimated again (below).
    const width = st.root.clientWidth;
    // A list mounted hidden learns its width here, even at the default one,
    // so the rows an earlier visit measured seed it.
    const widthChanged = width > 0 && width !== st.estimateWidth;
    if (widthChanged) st.estimateWidth = width;

    // A viewport that grew (pane enlarged, window maximized) needs more
    // rows than the window holds, with no scroll event to say so.
    const viewportHeight = st.root.clientHeight;
    if (viewportHeight !== st.lastViewportHeight) api.renderWindow();

    const jumpIdx = api.activeJumpIndex();
    if (jumpIdx !== -1) {
      if (widthChanged) api.reseedUnmeasured();
      api.measureRendered();
      api.updateSpacers();
      api.centreOnIndex(jumpIdx);
      return;
    }

    // Where the reader was before the content changed size: a row near the
    // bottom that grew past the threshold has already moved the bottom away
    // by the time this runs, which must not unpin a reader who was at it.
    const atBottom = api.isNearBottom() || st.bottomGapBeforeResize < SCROLL_BOTTOM_THRESHOLD;

    // Capture anchor: the first item that starts in view, and its offset
    // from the viewport top. Not the item straddling the top edge: growth
    // inside it (an image box settling below its header) would then move
    // every row the reader is looking at.
    const { scrollTop, clientHeight } = readMetrics(st.root);
    const anchorIdx = firstRowStartingInView(scrollTop, clientHeight);
    const anchorOffset = scrollTop - api.offsetBefore(anchorIdx);

    // The anchor above was read against the old estimates; the restore
    // below reads the new ones, so the reading position holds.
    if (widthChanged) api.reseedUnmeasured();

    // Re-measure rendered elements
    api.measureRendered();

    // Update spacer heights with new measurements
    api.updateSpacers();

    // Restore scroll position using anchor
    if (atBottom) {
      // A list mounted while hidden still owes the reader its NEW divider
      // or the spot they left.
      if (!api.openAtDividerIfReady() && !api.restoreReadingPositionIfReady()) {
        api.scrollToBottom();
      }
    } else {
      api.setScrollTop(api.offsetBefore(anchorIdx) + anchorOffset);
    }
    st.bottomGapBeforeResize = api.bottomGap();
    api.keepEditorCaretInView();
  };
  st.resizeObserver = new ResizeObserver(() => {
    if (st.root === null || st.contentContainer === null) return;
    // Hidden (the call grid has the chat column, display: none): nothing is
    // laid out, so there is nothing to measure, and the position from before
    // it was hidden is what showing it again restores.
    if (st.root.clientHeight === 0) return;
    const buildsRows =
      st.root.clientHeight !== st.lastViewportHeight ||
      api.activeJumpIndex() !== -1 ||
      st.openAtDividerPending ||
      st.restorePosition !== null;
    if (!buildsRows) {
      if (st.resizeRafId === 0) resizePass();
      return;
    }
    if (st.resizeRafId !== 0) return;
    st.resizeRafId = requestAnimationFrame(() => {
      st.resizeRafId = 0;
      if (st.root !== null && st.root.clientHeight > 0) resizePass();
    });
  });
  st.resizeObserver.observe(content);
  st.resizeObserver.observe(root);
}
