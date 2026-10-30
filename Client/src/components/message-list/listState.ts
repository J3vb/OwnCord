/** The mutable state one message list instance keeps, shared by its modules. */
import type { Disposable } from "@lib/disposable";
import type { Message } from "@stores/messages.store";
import type { MessageRenderOptions } from "./renderers";
import type { InlineEditSession } from "../../features/messaging/inlineEdit";
import type { VirtualItem } from "./virtualItems";
import type { FenwickTree } from "./fenwick";
import type { ScrollMetrics } from "./listShared";
import type { MessageListOptions } from "../MessageList";

export interface ListState {
  readonly options: MessageListOptions;
  readonly disposable: Disposable;
  readonly unsubscribers: Array<() => void>;
  /** Message ids of blocked authors whose run the reader opened, for this mount. */
  readonly shownBlocked: Set<number>;
  readonly renderOptions: MessageRenderOptions;
  /**
   * One owner per rendered message row, scoping that row's listeners (react/
   * reply/pin/edit/delete/copy-link, reply-ref, reaction chips, ...). A row
   * discarded by a rebuild or replaced by a row patch has its owner destroyed
   * at once, so its listeners never outlive it — every row used to register
   * against `disposable.signal` directly, retaining a full window of detached
   * rows (and everything they reference: videos, images, embeds, tooltips)
   * per rebuild. destroy() releases the rest.
   */
  readonly rowOwners: Map<HTMLElement, Disposable>;
  /**
   * The open inline editor: at most one per list. `session` is null
   * while the lazy chunk loads; `gen` tells a late load that it was superseded.
   */
  edit: { readonly messageId: number; session: InlineEditSession | null; gen: number } | null;
  editGen: number;
  // The editor held focus when its row was released by a window slide; it is
  // focused again when the row comes back.
  editRefocus: boolean;
  /** Non-scrolling frame around the scroller; what is actually appended to
   *  the parent. The floating controls anchor to this box — an absolutely
   *  positioned box whose containing block is the scroller itself sits in
   *  its scrollable overflow and translates with the content. */
  region: HTMLDivElement | null;
  root: HTMLDivElement | null;
  wasAtBottom: boolean;
  // Virtual scroll state
  virtualItems: readonly VirtualItem[];
  allMessages: readonly Message[];
  /** Every loaded message, tombstones included: a reply resolves its parent
   *  here, so a parent deleted live reads as deleted, not as unknown. Only
   *  `allMessages` (the rows drawn) leaves tombstones out. */
  replyParents: readonly Message[];
  /** itemKey -> measured px */
  readonly heightCache: Map<string, number>;
  /** Width the unmeasured rows' text estimates wrap at; the real one once the
   *  ResizeObserver has seen the list. */
  estimateWidth: number | undefined;
  tree: FenwickTree | null;
  topSpacer: HTMLDivElement | null;
  bottomSpacer: HTMLDivElement | null;
  contentContainer: HTMLDivElement | null;
  scrollToBottomBtn: HTMLButtonElement | null;
  unreadBar: HTMLDivElement | null;
  unreadBarLabel: HTMLSpanElement | null;
  unreadAnnouncer: HTMLDivElement | null;
  unreadBarDismissed: boolean;
  /** The visit still owes the reader a jump to the NEW divider (cleared on first use). */
  openAtDividerPending: boolean;
  scrollToBottomCount: HTMLSpanElement | null;
  /** Messages from others that landed below the view since the reader scrolled up. */
  newBelowCount: number;
  jumpToPresentPill: HTMLButtonElement | null;
  renderedStart: number;
  renderedEnd: number;
  /** The signed-in user's MANAGE_MESSAGES state at the last roleRevision, so a
   *  role change that flips it (which can add or remove a row's delete/pin
   *  controls) still rebuilds, while a rename or a plain repaint does not. */
  lastCanManageMessages: boolean;
  // scrollToMessage's highlight-flash: at most one outstanding flash at a
  // time, so its cleanup timer never needs a per-call abort listener (which
  // would accumulate one listener — and pin one row element — per jump).
  flashTimer: number;
  flashEl: HTMLElement | null;
  /**
   * Unread count this channel carried when the visit that created this list
   * began. Read once here, not per render: the badge is cleared by the visit
   * itself, and the divider must stay put for the whole visit rather than
   * jumping as new messages arrive. Zero once the reader comes back, which is
   * what makes the divider clear on the next visit.
   *
   * Suppressed while the window is detached (jumped to an old message): the
   * loaded slice is then not the tail, so "the last N messages" would put the
   * line somewhere arbitrary. The count is still kept for the whole visit —
   * a jump into another channel mounts this list before its around-window
   * lands, so detachment is re-read at every placement
   * (resolveNewDividerIndex), and returning to the tail restores the line.
   *
   * A count at UNREAD_COUNT_CAP is only a lower bound, so it reads as "every
   * loaded message is unread": the divider stays at the top of the loaded
   * window as older history is prepended and never latches to a count-derived
   * row that could leave real unread messages above it.
   */
  openedUnread: number;
  unreadOnOpen: number;
  /** True from the first Mark Unread here: the unread count the bar shows is the channel's now. */
  markedUnread: boolean;
  /** The bottom was reached and marked since the reader last left it (or was away). */
  bottomMarked: boolean;
  /**
   * Message id the NEW divider is anchored to, once one has been picked.
   * `firstUnreadIndex` returns a count-from-the-end offset, which drifts
   * whenever the loaded window grows (new messages arrive) between one full
   * rebuild and the next — the exact thing unreadOnOpen's doc comment above
   * promises won't happen. Latching onto the message id the first valid index
   * pointed at keeps the divider glued to that message for the rest of the
   * visit regardless of how the window grows around it.
   */
  newDividerAnchorId: number | null;
  /**
   * The read pointer the NEW line follows, when the server keeps one: the one
   * the channel had when it was opened (a visit moves the live pointer), or
   * the one Mark Unread just set. The line goes on the first loaded message
   * above it. Undefined keeps the count-based line.
   */
  linePointer: number | undefined;
  /** Set while the divider waits for a revisit's refetched tail. */
  newDividerDeferred: boolean;
  /** The loaded-and-empty welcome state is what the region currently shows. */
  loadedEmptyShown: boolean;
  // Scroll helpers
  // Set by the reader's own send; held while the window is detached, until
  // the live tail lands and the next render scrolls to it. It lapses if the
  // tail never lands, so a later reattach cannot pull the reader down.
  followOwnSendUntil: number;
  /** The metrics handleScroll read this frame, for the scroll rAF's renderWindow
   *  to reuse. Dropped by any renderWindow or scrollToBottom, so it never
   *  outlives a pass or a write that could have moved the viewport. */
  scrollSnapshot: ScrollMetrics | null;
  /** Distance from the bottom at the last scroll event or resize pass: what the
   *  resize observer judges "at the bottom" by, since by the time it runs a
   *  grown row has already pushed the bottom further away. */
  bottomGapBeforeResize: number;
  /** What the pill shows now, so a scroll burst writes the DOM only on a change. */
  btnShownKey: string;
  /** What the list showed before the latest Mark Unread, to go back to if it fails. */
  unmarked: {
    readonly linePointer: number | undefined;
    readonly newDividerAnchorId: number | null;
    readonly markedUnread: boolean;
    readonly unreadBarDismissed: boolean;
    readonly openedUnread: number;
    readonly unreadOnOpen: number;
  } | null;
  // The last jumped-to message, re-centred from the resize callback while
  // content above it is still sizing.
  jumpTarget: { readonly messageId: number; readonly until: number } | null;
  renderWindowCount: number;
  renderWindowResetTimer: number;
  // Set when the breaker below drops a rebuild. Like renderAllSuppressed, the
  // 2s reset replays renderWindow once, so a fast scrollbar drag that trips it
  // still ends with the rows for where it stopped. Once per burst, not
  // per dropped call, so the image-height oscillation it stops cannot restart.
  renderWindowSuppressed: boolean;
  // Guard against re-entrant renderAll calls (e.g. if a subscriber fires
  // during rendering). Also detects rapid-fire loops.
  renderAllRunning: boolean;
  renderAllCount: number;
  renderAllResetTimer: number;
  // Set when the rapid-fire breaker below drops a renderAll() call on the
  // floor. The store change that triggered the dropped call is still live —
  // without this, the DOM is left showing pre-burst state until some later,
  // unrelated store event happens to call renderAll() again. The 2s reset
  // timeout checks this flag and issues one final renderAll() so the burst's
  // last state always makes it to the screen.
  renderAllSuppressed: boolean;
  // Scroll / load-more handling
  loadingOlder: boolean;
  olderRetryAt: number;
  // In-flight latch for the page below a detached window: rapid scrolling
  // fires one fetch, not one per scroll event. Also marks the store change
  // that lands while it is set as a history page, not a live arrival.
  loadingNewer: boolean;
  newerRetryAt: number;
  /** Spinner row at the top of the history while an older page is in flight.
   *  Absolutely positioned in the scroller, so showing or hiding it never
   *  moves the rows (and never fires a scroll that could refetch). */
  olderLoadingRow: HTMLDivElement | null;
  /** "Couldn't load messages" + Retry over the top of the history after a failed
   *  older-page fetch. Overlays the region like the spinner, so no row moves. */
  olderFailedRow: HTMLDivElement | null;
  // The oldest loaded message's id, not the count: a live tail append also
  // changes the count while a history fetch is still in flight, and
  // resetting the latch on that lets the next scroll refire loadOlderMessages
  // with the same unchanged cursor -- the same page then lands twice. Only a
  // prepend moves messages[0]. Seeded from the current state (not left at a
  // placeholder) so the first change observed after construction is compared
  // against reality, not an arbitrary initial value.
  prevOldestId: number | null;
  scrollRafId: number;
  resizeRafId: number;
  /** The scroll viewport's height at the last resize pass: the window's overscan
   *  is a distance, so it must be recomputed when the viewport grows or shrinks. */
  lastViewportHeight: number;
  resizeObserver: ResizeObserver | null;
  // Profile popup (author name, avatar, @mention chip)
  /** Closes the popup this list opened; null until one has been. */
  closeProfilePopup: (() => void) | null;
}

/** Every function the list's modules share, filled in once by createMessageList. */
export interface ListApi {
  resolveNewDividerIndex(messages: readonly Message[]): number;
  renderVirtualItem(item: VirtualItem): HTMLElement;
  releaseRow(el: HTMLElement): void;
  itemKey(index: number): string;
  keyOf(item: VirtualItem | undefined, index: number): string;
  getItemHeight(index: number): number;
  rememberKey(index: number): string | null;
  estimateRow(index: number): number;
  totalHeight(): number;
  offsetToIndex(scrollTop: number): number;
  offsetBefore(index: number): number;
  measureRendered(from?: number, to?: number): void;
  updateSpacers(): void;
  releaseTrackedMedia(): void;
  captureRowFocus(): { own: string | null; row: string | null; index: number } | null;
  restoreRowFocus(
    captured: { own: string | null; row: string | null; index: number } | null,
  ): boolean;
  beginRowRender(): void;
  activeJumpIndex(): number;
  edgeOf(el: Element): number;
  holdRow(el: Element, edge: number): void;
  shiftWindow(
    start: number,
    end: number,
    view: Pick<ScrollMetrics, "scrollTop" | "clientHeight">,
  ): void;
  refocusEditor(): void;
  renderWindow(m?: ScrollMetrics): void;
  rebuildItems(): void;
  reseedUnmeasured(): void;
  seedTree(): void;
  keepsRenderedRows(
    prevItems: readonly VirtualItem[],
    prevKeys: readonly string[],
    prevIndex: ReadonlyMap<string, number>,
    nextKeys: readonly string[],
    nextIndex: ReadonlyMap<string, number>,
    start: number,
    end: number,
  ): boolean;
  patchRows(): boolean;
  topMessageIndex(): number;
  renderedRowAt(idx: number): Element | undefined;
  renderAll(hold?: { readonly key: string; readonly edge: number }): void;
  ownSends(list: readonly Message[]): number;
  followOwnSend(): boolean;
  keepBottom(): boolean;
  setScrollTop(top: number): void;
  isNearBottom(threshold?: number, m?: ScrollMetrics): boolean;
  isAtBottom(m?: ScrollMetrics): boolean;
  scrollToBottom(): void;
  bottomGap(m?: ScrollMetrics): number;
  updateScrollToBottomBtn(m?: ScrollMetrics): void;
  updateJumpToPresentPill(): void;
  scrollPage(direction: 1 | -1): void;
  setLoadingOlder(value: boolean): void;
  updateOlderFailedRow(): void;
  retryOlder(): void;
  lastSentId(): number;
  fireOlderLoad(): void;
  handleScroll(): void;
  placeIndex(idx: number, offset: number): boolean;
  centreOnIndex(idx: number): boolean;
  scrollToMessage(messageId: number): boolean;
  runIds(firstId: number, lastId: number): number[];
  expandRunOf(messageId: number): boolean;
  toggleBlockedRun(firstId: number): void;
  revealIndex(idx: number, flash: boolean, recentre?: boolean): boolean;
  openAtDividerIfReady(): boolean;
  updateUnreadBar(): void;
  dismissUnreadBar(): void;
  markReadAndJumpToPresent(): void;
  settleUnreadNav(): void;
  markReadIfSeen(m?: ScrollMetrics): void;
  noteVisibleRowsSeen(m?: ScrollMetrics): void;
  newestLoadedId(): number;
  markUnreadFrom(messageId: number): void;
  revertMarkUnread(): void;
  refreshUnreadFromChannel(markedId: number): void;
  markLiveArrivalSeen(): void;
  refreshAuthorRows(): void;
  repaintReplyRefAuthors(row: HTMLElement): void;
  relabelRenderedTimes(): void;
  editHoldsFocus(): boolean;
  replaceRenderedRow(id: number): void;
  closeEdit(notify: boolean): void;
  dropGoneEdit(hadFocus: boolean): void;
  keepEditorCaretInView(): void;
  startEdit(messageId: number, text?: string, opts?: { readonly focus?: boolean }): boolean;
  cancelEdit(): void;
  isEditing(): boolean;
}
