/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { createElement, clearChildren } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/safe-render";
import {
  messagesStore,
  getChannelMessages,
  hasMoreMessages,
  getHistoryLoadState,
  isWindowDetached,
} from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import { unobserveMedia } from "@lib/media-visibility";

const log = createLogger("message-list");
import {
  shouldGroup,
  isSameDay,
  renderDayDivider,
  renderNewDivider,
  renderMessage,
} from "./message-list/renderers";
import { getUnreadOnOpen } from "@stores/channels.store";
import { isAudioMime, isVideoMime } from "./message-list/attachments";
import { FenwickTree } from "./message-list/fenwick";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly channelType?: string;
  readonly currentUserId: number;
  /** May return a promise (e.g. the underlying fetch); MessageList clears its
   *  loadingOlder latch once it settles, success or failure. */
  readonly onScrollTop: () => void | Promise<void>;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  readonly onDeleteClick: (messageId: number) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
  /** Retry a failed optimistic send (by its correlation id). */
  readonly onRetry?: (correlationId: string) => void;
  /** Discard a failed optimistic send without retrying. */
  readonly onDeleteDraft?: (correlationId: string) => void;
  /** Retry a failed first-page history fetch. */
  readonly onRetryLoad?: () => void;
  /**
   * Jump to another message in this channel — the reply bar above a reply, and
   * any other in-row affordance. May target a message outside the loaded
   * window; the handler is expected to fetch the around-window in that case.
   */
  readonly onJumpToMessage?: (messageId: number) => void;
  /**
   * Leave a detached around-window and reload the live tail. Wired to the
   * "Jump to Present" pill, which only appears while the window is detached.
   */
  readonly onJumpToPresent?: () => void;
}

// -- Constants ----------------------------------------------------------------

const SCROLL_TOP_THRESHOLD = 50;
const SCROLL_BOTTOM_THRESHOLD = 100;

/** Number of items to render beyond visible viewport in each direction. */
const OVERSCAN = 20;

/** Regex for direct image URLs in message content. */
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?(?:\s|$)/i;

/** Regex for YouTube URLs in message content. */
const YOUTUBE_URL_RE = /(?:youtube\.com\/watch|youtu\.be\/)/i;

// -- Virtual item types -------------------------------------------------------

interface VirtualItemMessage {
  readonly kind: "message";
  readonly message: Message;
  readonly isGrouped: boolean;
}

interface VirtualItemDivider {
  readonly kind: "divider";
  readonly timestamp: string;
}

/** The "NEW" line marking where the reader's unread messages begin. At most
 *  one per list, and only for a visit that opened with unread messages. */
interface VirtualItemNewDivider {
  readonly kind: "new-divider";
}

type VirtualItem = VirtualItemMessage | VirtualItemDivider | VirtualItemNewDivider;

// -- Smart height estimation --------------------------------------------------

function estimateItemHeight(item: VirtualItem): number {
  if (item.kind === "divider" || item.kind === "new-divider") return 32;

  // Non-grouped: min-height 2.75rem (44px @16px root) + margin-top 17px = 61px
  // Grouped: min-height 1.375rem (22px @16px root) + margin-top 0px = 22px
  let height = item.isGrouped ? 22 : 61;

  // Media attachments. Video shares the image box, so it reserves the same
  // space; the audio player is a chip-height row.
  for (const att of item.message.attachments) {
    if (isVideoMime(att.mime)) {
      height += 220;
    } else if (isAudioMime(att.mime)) {
      height += 96;
    } else if (att.mime.startsWith("image/")) {
      height += 220;
    }
  }

  // Inline image URLs in content
  if (IMAGE_URL_RE.test(item.message.content)) {
    height += 220;
  }

  // YouTube embeds
  if (YOUTUBE_URL_RE.test(item.message.content)) {
    height += 320;
  }

  return height;
}

// -- Pre-process messages into virtual items ----------------------------------

/** Build virtual items for `messages`. The optional seed (`prevMsg` /
 *  `lastTimestamp`) lets the incremental tail-append path continue grouping and
 *  day-divider logic from an already-built item list. */
function buildVirtualItems(
  messages: readonly Message[],
  seedPrevMsg: Message | null = null,
  seedLastTimestamp: string | null = null,
  newDividerAt = -1,
): readonly VirtualItem[] {
  const items: VirtualItem[] = [];
  let lastTimestamp: string | null = seedLastTimestamp;
  let prevMsg: Message | null = seedPrevMsg;

  for (const [i, msg] of messages.entries()) {
    if (lastTimestamp === null || !isSameDay(lastTimestamp, msg.timestamp)) {
      items.push({ kind: "divider", timestamp: msg.timestamp });
    }
    const isFirstUnread = i === newDividerAt;
    if (isFirstUnread) {
      items.push({ kind: "new-divider" });
    }
    // A message directly under the NEW line starts a fresh block: rendering it
    // as a grouped continuation of a message from before the line hides both
    // its author and the fact that the line is there.
    const isGrouped =
      !isFirstUnread &&
      prevMsg !== null &&
      isSameDay(prevMsg.timestamp, msg.timestamp) &&
      shouldGroup(prevMsg, msg);
    items.push({ kind: "message", message: msg, isGrouped });
    lastTimestamp = msg.timestamp;
    prevMsg = msg;
  }
  return items;
}

/**
 * Index of the first unread message in `messages`, or -1 for none.
 *
 * Derived from the unread count the channel had when it was opened (the
 * badge itself is cleared by the visit): the last N loaded messages are the
 * unread ones. Clamped to 0 when the whole loaded window is unread, and
 * suppressed at 0-length so an empty channel never renders a lone divider.
 */
function firstUnreadIndex(messages: readonly Message[], unreadOnOpen: number): number {
  if (unreadOnOpen <= 0 || messages.length === 0) return -1;
  return Math.max(0, messages.length - unreadOnOpen);
}

// -- Empty state --------------------------------------------------------------

function renderEmptyState(channelName: string, channelType?: string): HTMLDivElement {
  const isDm = channelType === "dm";

  const icon = createElement("div", { class: "channel-welcome-icon" });
  icon.textContent = isDm ? "@" : "#";

  const title = createElement("h2", { class: "channel-welcome-title" });
  title.textContent = isDm ? channelName : `Welcome to #${channelName}!`;

  const text = createElement("p", { class: "channel-welcome-text" });
  text.textContent = isDm
    ? `This is the beginning of your direct message history with ${channelName}.`
    : `This is the start of the #${channelName} channel.`;

  const wrapper = createElement("div", { class: "channel-welcome" });
  wrapper.appendChild(icon);
  wrapper.appendChild(title);
  wrapper.appendChild(text);

  return wrapper;
}

/** In-region placeholder while the first page of history is loading. */
function renderLoadingState(): HTMLDivElement {
  const wrapper = createElement("div", { class: "messages-loading" });
  wrapper.appendChild(createElement("div", { class: "spinner" }));
  const text = createElement("p", { class: "messages-loading-text" });
  text.textContent = "Loading messages…";
  wrapper.appendChild(text);
  return wrapper;
}

/** In-region inline error + Retry when the first-page history fetch failed. */
function renderLoadErrorState(onRetryLoad?: () => void): HTMLDivElement {
  const wrapper = createElement("div", { class: "messages-load-error" });
  const text = createElement("p", { class: "messages-load-error-text" });
  text.textContent = "Couldn't load messages";
  wrapper.appendChild(text);
  const retry = createElement("button", {
    class: "messages-retry-btn",
    "data-testid": "messages-retry",
  });
  retry.textContent = "Retry";
  retry.addEventListener("click", () => onRetryLoad?.());
  wrapper.appendChild(retry);
  return wrapper;
}

// -- Factory ------------------------------------------------------------------

export type MessageListComponent = MountableComponent & {
  /** Scroll to a message by ID. Returns false if the message is not in the loaded window. */
  scrollToMessage(messageId: number): boolean;
};

export function createMessageList(options: MessageListOptions): MessageListComponent {
  const ac = new AbortController();
  const unsubscribers: Array<() => void> = [];
  /** Non-scrolling frame around the scroller; what is actually appended to
   *  the parent. The floating controls anchor to this box — an absolutely
   *  positioned box whose containing block is the scroller itself sits in
   *  its scrollable overflow and translates with the content. */
  let region: HTMLDivElement | null = null;
  let root: HTMLDivElement | null = null;
  let wasAtBottom = true;

  // Virtual scroll state
  let virtualItems: readonly VirtualItem[] = [];
  let allMessages: readonly Message[] = [];
  const heightCache = new Map<string, number>(); // itemKey -> measured px
  let tree: FenwickTree | null = null;
  let topSpacer: HTMLDivElement | null = null;
  let bottomSpacer: HTMLDivElement | null = null;
  let contentContainer: HTMLDivElement | null = null;
  let scrollToBottomBtn: HTMLButtonElement | null = null;
  let jumpToPresentPill: HTMLButtonElement | null = null;
  let renderedStart = 0;
  let renderedEnd = 0;

  // scrollToMessage's highlight-flash: at most one outstanding flash at a
  // time, so its cleanup timer never needs a per-call abort listener (which
  // would accumulate one listener — and pin one row element — per jump).
  let flashTimer = 0;
  let flashEl: HTMLElement | null = null;

  /**
   * Unread count this channel carried when the visit that created this list
   * began. Read once here, not per render: the badge is cleared by the visit
   * itself, and the divider must stay put for the whole visit rather than
   * jumping as new messages arrive. Zero once the reader comes back, which is
   * what makes the divider clear on the next visit.
   *
   * Suppressed while the window is detached (jumped to an old message): the
   * loaded slice is then not the tail, so "the last N messages" would put the
   * line somewhere arbitrary.
   */
  const unreadOnOpen = isWindowDetached(options.channelId) ? 0 : getUnreadOnOpen(options.channelId);

  /**
   * Message id the NEW divider is anchored to, once one has been picked.
   * `firstUnreadIndex` returns a count-from-the-end offset, which drifts
   * whenever the loaded window grows (new messages arrive) between one full
   * rebuild and the next — the exact thing unreadOnOpen's doc comment above
   * promises won't happen. Latching onto the message id the first valid index
   * pointed at keeps the divider glued to that message for the rest of the
   * visit regardless of how the window grows around it.
   */
  let newDividerAnchorId: number | null = null;

  /**
   * Resolve the NEW divider's position for this rebuild. Prefers the latched
   * anchor id (stable across window growth); falls back to the count formula
   * only until an anchor exists, then latches it — skipping id 0 (an
   * unconfirmed optimistic row) since that id is not unique across pending
   * sends and would anchor to the wrong message once reconciled.
   *
   * Also skips latching while the window is shorter than unreadOnOpen: the
   * initial mount can render one live message (via the append path) before
   * the async history fetch resolves, and firstUnreadIndex's
   * `Math.max(0, ...)` clamp turns that 1-row window into index 0 just like a
   * real boundary would. Latching onto that message would glue the divider
   * to whatever happened to arrive first instead of the actual unread
   * boundary once the full window loads.
   */
  function resolveNewDividerIndex(messages: readonly Message[]): number {
    if (newDividerAnchorId !== null) {
      return messages.findIndex((m) => m.id === newDividerAnchorId);
    }
    const idx = firstUnreadIndex(messages, unreadOnOpen);
    const anchor = idx !== -1 ? messages[idx] : undefined;
    if (anchor !== undefined && anchor.id !== 0 && messages.length >= unreadOnOpen) {
      newDividerAnchorId = anchor.id;
    }
    return idx;
  }

  // ---------------------------------------------------------------------------
  // Height estimation (Fenwick tree backed)
  // ---------------------------------------------------------------------------

  /** Render one virtual item — the single place the three item kinds map to DOM. */
  function renderVirtualItem(item: VirtualItem): HTMLElement {
    if (item.kind === "divider") return renderDayDivider(item.timestamp);
    if (item.kind === "new-divider") return renderNewDivider();
    return renderMessage(item.message, item.isGrouped, allMessages, options, ac.signal);
  }

  function itemKey(index: number): string {
    const item = virtualItems[index];
    if (item === undefined) return `idx-${index}`;
    if (item.kind === "divider") return `div-${item.timestamp}`;
    if (item.kind === "new-divider") return "new-divider";
    // Every unconfirmed optimistic row (addOptimisticMessage) carries
    // id: 0 until confirmSend stamps the real id, so keying purely on
    // message.id would collide two or more pending rows onto the same
    // "msg-0" cache entry — measureRendered would overwrite one row's
    // measured height with another's, and the next Fenwick rebuild
    // (rebuildItems / tryAppendMessages) would seed both rows' tree slots
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
    const cached = heightCache.get(itemKey(index));
    if (cached !== undefined) return cached;
    return estimateItemHeight(virtualItems[index]!);
  }

  function totalHeight(): number {
    if (tree !== null) return tree.total();
    let h = 0;
    for (let i = 0; i < virtualItems.length; i++) {
      h += getItemHeight(i);
    }
    return h;
  }

  function offsetToIndex(scrollTop: number): number {
    if (tree !== null) return tree.findIndex(scrollTop);
    let offset = 0;
    for (let i = 0; i < virtualItems.length; i++) {
      const h = getItemHeight(i);
      if (offset + h > scrollTop) return i;
      offset += h;
    }
    return virtualItems.length - 1;
  }

  function offsetBefore(index: number): number {
    if (tree !== null && index > 0) return tree.prefixSum(index - 1);
    if (tree !== null && index <= 0) return 0;
    let offset = 0;
    for (let i = 0; i < index && i < virtualItems.length; i++) {
      offset += getItemHeight(i);
    }
    return offset;
  }

  // ---------------------------------------------------------------------------
  // Scroll helpers
  // ---------------------------------------------------------------------------

  function isNearBottom(): boolean {
    if (root === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = root;
    return scrollHeight - scrollTop - clientHeight < SCROLL_BOTTOM_THRESHOLD;
  }

  function scrollToBottom(): void {
    if (root === null) return;
    root.scrollTop = root.scrollHeight;
  }

  function updateScrollToBottomBtn(): void {
    if (scrollToBottomBtn === null) return;
    if (isNearBottom()) {
      scrollToBottomBtn.classList.remove("visible");
    } else {
      scrollToBottomBtn.classList.add("visible");
    }
  }

  /** The pill is the only signal that the bottom of the list is not "now". */
  function updateJumpToPresentPill(): void {
    if (jumpToPresentPill === null) return;
    jumpToPresentPill.classList.toggle("visible", isWindowDetached(options.channelId));
  }

  // ---------------------------------------------------------------------------
  // Render visible window
  // ---------------------------------------------------------------------------

  function measureRendered(): void {
    if (contentContainer === null || renderedStart < 0) return;
    const children = contentContainer.children;

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
    for (let i = 0; i < children.length; i++) {
      const globalIdx = renderedStart + i;
      if (globalIdx < 0 || (tree !== null && globalIdx >= tree.size)) continue;
      const el = children[i] as HTMLElement;
      const style = getComputedStyle(el);
      const h = el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      if (h > 0) {
        measurements.push({ key: itemKey(globalIdx), idx: globalIdx, h });
      }
    }

    // Pass 2 — pure writes: apply all cached heights to heightCache and the
    // Fenwick tree. No DOM reads here, so no additional reflow is triggered.
    for (const { key, idx, h } of measurements) {
      heightCache.set(key, h);
      if (tree !== null) {
        tree.set(idx, h);
      }
    }
  }

  function updateSpacers(): void {
    if (topSpacer !== null) {
      topSpacer.style.height = `${offsetBefore(renderedStart)}px`;
    }
    if (bottomSpacer !== null) {
      if (tree !== null) {
        const totalH = tree.total();
        const endOffset = renderedEnd > 0 ? tree.prefixSum(renderedEnd - 1) : 0;
        bottomSpacer.style.height = `${totalH - endOffset}px`;
      } else {
        let bh = 0;
        for (let i = renderedEnd; i < virtualItems.length; i++) bh += getItemHeight(i);
        bottomSpacer.style.height = `${bh}px`;
      }
    }
  }

  /** Release IntersectionObserver tracking, pending freeze timers, and frozen-
   *  frame data URLs for GIFs in rows that are about to be discarded — without
   *  this, media-visibility retains every <img> ever rendered. Must run before
   *  every clearChildren(contentContainer) and on destroy. */
  function releaseTrackedMedia(): void {
    if (contentContainer === null) return;
    for (const img of contentContainer.querySelectorAll("img")) {
      unobserveMedia(img);
    }
  }

  let renderWindowCount = 0;
  let renderWindowResetTimer = 0;

  function renderWindow(): void {
    if (root === null || contentContainer === null || topSpacer === null || bottomSpacer === null)
      return;

    const scrollTop = root.scrollTop;
    const clientHeight = root.clientHeight;

    if (virtualItems.length === 0) {
      releaseTrackedMedia();
      clearChildren(contentContainer);
      // With no rows, the region shows the fetch state: an in-region loading
      // placeholder, an inline error + Retry, or the welcome/empty state once
      // the channel is actually loaded and empty (UX spec §1/§2).
      const loadState = getHistoryLoadState(options.channelId);
      if (loadState === "loading") {
        contentContainer.appendChild(renderLoadingState());
      } else if (loadState === "error") {
        contentContainer.appendChild(renderLoadErrorState(options.onRetryLoad));
      } else {
        contentContainer.appendChild(renderEmptyState(options.channelName, options.channelType));
      }
      topSpacer.style.height = "0px";
      bottomSpacer.style.height = "0px";
      renderedStart = 0;
      renderedEnd = 0;
      return;
    }

    // Determine visible range
    const firstVisible = offsetToIndex(scrollTop);
    const lastVisible = offsetToIndex(scrollTop + clientHeight);

    const start = Math.max(0, firstVisible - OVERSCAN);
    const end = Math.min(virtualItems.length, lastVisible + OVERSCAN + 1);

    // Rebuild the DOM when explicitly requested by renderAll (which sets
    // renderedStart to -1) or when the target range has left the rendered
    // window — scrolling past the overscan must materialize the rows the
    // spacers are standing in for. When the range is already fully rendered
    // this is a no-op, which (together with the rebuild rate limiter below)
    // prevents the height oscillation loop where images loading → height
    // change → range recalculation → DOM rebuild → images reload → repeat.
    const rangeAlreadyRendered = renderedStart >= 0 && start >= renderedStart && end <= renderedEnd;
    if (!rangeAlreadyRendered) {
      // Rate-limit DOM rebuilds only (expensive path).
      // Scroll-driven spacer updates are cheap and don't need limiting.
      renderWindowCount++;
      if (renderWindowCount > 30) {
        log.error("[MessageList] renderWindow REBUILD called >30 times in 2s — breaking loop");
        return;
      }
      if (renderWindowResetTimer === 0) {
        renderWindowResetTimer = window.setTimeout(() => {
          renderWindowCount = 0;
          renderWindowResetTimer = 0;
        }, 2000);
      }

      // Full rebuild: requested by renderAll, or the window is following a
      // scroll into a region that is not rendered yet.
      log.debug("renderWindow REBUILD", { start, end });

      // Measure current elements before replacing.
      measureRendered();

      renderedStart = start;
      renderedEnd = end;

      // Rebuild content
      releaseTrackedMedia();
      clearChildren(contentContainer);
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        fragment.appendChild(renderVirtualItem(virtualItems[i]!));
      }
      contentContainer.appendChild(fragment);

      // Measure newly rendered elements and update spacers
      measureRendered();
      updateSpacers();
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
    allMessages = getChannelMessages(options.channelId);
    virtualItems = buildVirtualItems(allMessages, null, null, resolveNewDividerIndex(allMessages));

    // Build Fenwick tree initialized with smart estimates / cached heights
    tree = new FenwickTree(virtualItems.length);
    for (let i = 0; i < virtualItems.length; i++) {
      const cached = heightCache.get(itemKey(i));
      const h = cached !== undefined ? cached : estimateItemHeight(virtualItems[i]!);
      tree.set(i, h);
    }
  }

  // ---------------------------------------------------------------------------
  // Incremental tail append (fast path)
  // ---------------------------------------------------------------------------

  /** Cap on rendered rows for the append fast path. Once the window grows past
   *  this, fall back to renderAll so it is re-trimmed to the visible range. */
  const MAX_INCREMENTAL_WINDOW = 200;

  /**
   * Fast path for the common "new message arrived at the tail" update: when
   * the store's array is a pure suffix extension of `allMessages`, append the
   * new rows and re-seed the Fenwick tree instead of tearing down the whole
   * rendered window (renderAll → renderWindow REBUILD). Anything else (edits,
   * deletes, history prepends, confirmations replacing optimistic rows)
   * returns false so the caller does a full rebuild.
   *
   * Scroll-anchor/spacer safety: no existing row is touched, so the anchor
   * item's offset only changes via the bottom spacer/appended rows below it;
   * the ResizeObserver's RAF pass re-measures and restores the anchor exactly
   * as it does for image loads. The renderWindow oscillation guard is not
   * consumed — this path never rebuilds.
   */
  function tryAppendMessages(): boolean {
    if (root === null || contentContainer === null || tree === null) return false;
    if (renderAllRunning || renderedStart < 0) return false;

    const prev = allMessages;
    const next = getChannelMessages(options.channelId);
    if (prev.length === 0 || next.length <= prev.length) return false;
    for (let i = 0; i < prev.length; i++) {
      if (next[i] !== prev[i]) return false;
    }

    const prevLast = prev[prev.length - 1]!;
    const appendedItems = buildVirtualItems(next.slice(prev.length), prevLast, prevLast.timestamp);
    const oldItemCount = virtualItems.length;
    const windowAtTail = renderedEnd === oldItemCount;
    if (
      windowAtTail &&
      renderedEnd - renderedStart + appendedItems.length > MAX_INCREMENTAL_WINDOW
    ) {
      return false; // window has grown too large — let renderAll re-trim it
    }

    const atBottom = isNearBottom();

    // Capture measured heights of the currently rendered rows before swapping
    // trees so the rebuilt tree starts from real measurements.
    measureRendered();

    allMessages = next;
    virtualItems = [...virtualItems, ...appendedItems];

    // Extend the height index. FenwickTree is fixed-size, so re-seed a fresh
    // one from the height cache — cheap relative to the DOM teardown this
    // path avoids.
    tree = new FenwickTree(virtualItems.length);
    for (let i = 0; i < virtualItems.length; i++) {
      const cached = heightCache.get(itemKey(i));
      tree.set(i, cached !== undefined ? cached : estimateItemHeight(virtualItems[i]!));
    }

    if (windowAtTail) {
      // The rendered window includes the old tail — append the new rows.
      const fragment = document.createDocumentFragment();
      for (const item of appendedItems) {
        fragment.appendChild(renderVirtualItem(item));
      }
      contentContainer.appendChild(fragment);
      renderedEnd = virtualItems.length;
      measureRendered();
    }
    // Otherwise the user has scrolled up past the tail: the new items only
    // grow the bottom spacer; renderWindow picks them up on the next rebuild.

    updateSpacers();
    if (atBottom) {
      scrollToBottom();
      updateScrollToBottomBtn();
    }
    return true;
  }

  // Guard against re-entrant renderAll calls (e.g. if a subscriber fires
  // during rendering). Also detects rapid-fire loops.
  let renderAllRunning = false;
  let renderAllCount = 0;
  let renderAllResetTimer = 0;
  // Set when the rapid-fire breaker below drops a renderAll() call on the
  // floor. The store change that triggered the dropped call is still live —
  // without this, the DOM is left showing pre-burst state until some later,
  // unrelated store event happens to call renderAll() again. The 2s reset
  // timeout checks this flag and issues one final renderAll() so the burst's
  // last state always makes it to the screen.
  let renderAllSuppressed = false;

  function renderAll(): void {
    if (root === null) return;
    if (renderAllRunning) return; // prevent re-entrancy

    // Detect rapid-fire loops: if renderAll is called more than 20 times
    // within 2 seconds, something is wrong — bail out to prevent freeze.
    renderAllCount++;
    if (renderAllCount > 20) {
      log.error("[MessageList] renderAll called >20 times in 2s — breaking loop");
      renderAllSuppressed = true;
      return;
    }
    if (renderAllResetTimer === 0) {
      renderAllResetTimer = window.setTimeout(() => {
        renderAllCount = 0;
        renderAllResetTimer = 0;
        if (renderAllSuppressed) {
          // Render the burst's final state once, now that it's over.
          renderAllSuppressed = false;
          renderAll();
        }
      }, 2000);
    }

    renderAllRunning = true;
    try {
      log.debug("renderAll START", { count: renderAllCount });
      wasAtBottom = isNearBottom();

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
      if (!wasAtBottom && root !== null && virtualItems.length > 0) {
        let anchorIdx = offsetToIndex(root.scrollTop);
        // The topmost item may be a day divider or the NEW divider, neither
        // of which has an identity that survives a rebuild — walk forward to
        // the message row that follows it (every divider is immediately
        // followed by one).
        while (anchorIdx < virtualItems.length && virtualItems[anchorIdx]!.kind !== "message") {
          anchorIdx++;
        }
        const anchorItem = virtualItems[anchorIdx];
        // id 0 is the unconfirmed-optimistic-row sentinel (see itemKey
        // above) — not unique across pending sends, so it cannot identify a
        // specific row to re-find after the rebuild.
        if (
          anchorItem !== undefined &&
          anchorItem.kind === "message" &&
          anchorItem.message.id !== 0
        ) {
          anchorMessageId = anchorItem.message.id;
          anchorOffsetInItem = root.scrollTop - offsetBefore(anchorIdx);
        }
      }

      rebuildItems();
      log.debug("renderAll rebuildItems done", { itemCount: virtualItems.length });

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
      if (wasAtBottom && root !== null) {
        const estTotal = totalHeight();
        if (topSpacer !== null) topSpacer.style.height = "0px";
        if (bottomSpacer !== null) bottomSpacer.style.height = `${estTotal}px`;
        root.scrollTop = Math.max(0, estTotal - root.clientHeight);
      } else if (anchorMessageId !== null && root !== null) {
        const newIdx = virtualItems.findIndex(
          (item) => item.kind === "message" && item.message.id === anchorMessageId,
        );
        if (newIdx !== -1) {
          // Same clamping hazard as the bottom branch above: inflate the
          // spacers to the freshly rebuilt estimated total before assigning
          // scrollTop, so a prepend's larger offset is not silently clamped
          // back down to the stale (smaller) pre-rebuild scrollHeight.
          const estTotal = totalHeight();
          if (topSpacer !== null) topSpacer.style.height = "0px";
          if (bottomSpacer !== null) bottomSpacer.style.height = `${estTotal}px`;
          root.scrollTop = Math.max(0, offsetBefore(newIdx) + anchorOffsetInItem);
        }
      }

      // Reset rendered range to force full re-render
      renderedStart = -1;
      renderedEnd = -1;

      renderWindow();
      log.debug("renderAll renderWindow done");

      // Correct scroll position with actual DOM measurements
      if (wasAtBottom) {
        scrollToBottom();
        updateScrollToBottomBtn();
      }
      log.debug("renderAll END");
    } finally {
      renderAllRunning = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Scroll / load-more handling
  // ---------------------------------------------------------------------------

  let loadingOlder = false;
  // The oldest loaded message's id, not the count: a live tail append also
  // changes the count while a history fetch is still in flight, and
  // resetting the latch on that lets the next scroll refire loadOlderMessages
  // with the same unchanged cursor -- the same page then lands twice. Only a
  // prepend moves messages[0]. Seeded from the current state (not left at a
  // placeholder) so the first change observed after construction is compared
  // against reality, not an arbitrary initial value.
  let prevOldestId: number | null = getChannelMessages(options.channelId)[0]?.id ?? null;

  const unsubLoadingReset = messagesStore.subscribeSelector(
    (s) => s.messagesByChannel,
    () => {
      const msgs = getChannelMessages(options.channelId);
      const oldestId = msgs.length > 0 ? msgs[0]!.id : null;
      if (oldestId !== prevOldestId) {
        prevOldestId = oldestId;
        loadingOlder = false;
      }
    },
  );

  let scrollRafId = 0;
  let resizeRafId = 0;
  let resizeObserver: ResizeObserver | null = null;
  // resizeDirty tracking removed — resize observer batches via RAF directly
  function handleScroll(): void {
    if (root === null) return;

    // Load older messages when near top
    if (
      root.scrollTop < SCROLL_TOP_THRESHOLD &&
      !loadingOlder &&
      hasMoreMessages(options.channelId)
    ) {
      loadingOlder = true;
      // A failed fetch never changes the message count, so the subscriber
      // below (which only reacts to a count change) would leave loadingOlder
      // latched forever. Clear it once the load settles either way — the
      // subscriber's reset still applies to the success path but is now just
      // belt-and-braces.
      void Promise.resolve(options.onScrollTop()).finally(() => {
        loadingOlder = false;
      });
    }

    // Update floating scroll-to-bottom button visibility
    updateScrollToBottomBtn();

    // Debounce virtual window updates to animation frames
    if (scrollRafId === 0) {
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        renderWindow();
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(parentContainer: Element): void {
    region = createElement("div", { class: "messages-region" });
    root = createElement("div", { class: "messages-container" });

    topSpacer = createElement("div", { class: "virtual-spacer-top" });
    contentContainer = createElement("div", { class: "virtual-content" });
    bottomSpacer = createElement("div", { class: "virtual-spacer-bottom" });
    const scrollAnchor = createElement("div", { class: "scroll-anchor" });

    scrollToBottomBtn = createElement("button", { class: "scroll-to-bottom-btn" });
    scrollToBottomBtn.textContent = "↓";
    scrollToBottomBtn.addEventListener(
      "click",
      () => {
        scrollToBottom();
        updateScrollToBottomBtn();
      },
      { signal: ac.signal },
    );

    jumpToPresentPill = createElement("button", {
      class: "jump-to-present-pill",
      "data-testid": "jump-to-present",
    });
    jumpToPresentPill.textContent = "Jump to Present ↓";
    jumpToPresentPill.addEventListener("click", () => options.onJumpToPresent?.(), {
      signal: ac.signal,
    });

    root.appendChild(topSpacer);
    root.appendChild(contentContainer);
    root.appendChild(bottomSpacer);
    root.appendChild(scrollAnchor);
    region.appendChild(root);
    region.appendChild(scrollToBottomBtn);
    region.appendChild(jumpToPresentPill);

    root.addEventListener("scroll", handleScroll, {
      signal: ac.signal,
      passive: true,
    });

    // Watch for height changes in rendered items (images loading, embeds expanding).
    // Batched via RAF with anchor-based scroll preservation.
    resizeObserver = new ResizeObserver(() => {
      if (root === null || contentContainer === null) return;
      if (resizeRafId !== 0) return;

      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (root === null || contentContainer === null) return;

        const atBottom = isNearBottom();

        // Capture anchor: topmost visible item and its offset from viewport top
        const anchorIdx = offsetToIndex(root.scrollTop);
        const anchorOffset = root.scrollTop - offsetBefore(anchorIdx);

        // Re-measure rendered elements
        measureRendered();

        // Update spacer heights with new measurements
        updateSpacers();

        // Restore scroll position using anchor
        if (atBottom) {
          scrollToBottom();
        } else {
          root.scrollTop = offsetBefore(anchorIdx) + anchorOffset;
        }
      });
    });
    resizeObserver.observe(contentContainer);

    parentContainer.appendChild(region);

    renderAll();
    updateJumpToPresentPill();
    scrollToBottom();
    const initialScrollRaf = requestAnimationFrame(() => scrollToBottom());
    ac.signal.addEventListener("abort", () => cancelAnimationFrame(initialScrollRaf));

    unsubscribers.push(
      messagesStore.subscribeSelector(
        // Scoped to the mounted channel so updates to OTHER channels (their
        // array references are unchanged) never trigger a re-render here.
        (s) => s.messagesByChannel.get(options.channelId),
        () => {
          if (!tryAppendMessages()) {
            renderAll();
          }
        },
      ),
    );

    // Re-render the (empty) region when the first-page fetch transitions
    // between loading / error / idle.
    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.historyLoadState.get(options.channelId),
        () => {
          renderAll();
        },
      ),
    );

    // Show/hide the pill as the window detaches from (and reattaches to) the
    // live tail. No re-render — only the pill's visibility changes.
    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.detachedChannels.has(options.channelId),
        () => {
          updateJumpToPresentPill();
        },
      ),
    );

    // Only re-render when member roles change, not on presence/typing updates.
    // The store bumps roleRevision solely on membership/role mutations, so
    // selecting the counter avoids rebuilding a role map per notification.
    unsubscribers.push(
      membersStore.subscribeSelector(
        (s) => s.roleRevision ?? 0,
        () => {
          renderAll();
        },
      ),
    );
  }

  function destroy(): void {
    if (resizeObserver !== null) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    ac.abort();
    if (scrollRafId !== 0) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = 0;
    }
    if (resizeRafId !== 0) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = 0;
    }
    if (renderAllResetTimer !== 0) {
      clearTimeout(renderAllResetTimer);
      renderAllResetTimer = 0;
    }
    if (renderWindowResetTimer !== 0) {
      clearTimeout(renderWindowResetTimer);
      renderWindowResetTimer = 0;
    }
    if (flashTimer !== 0) {
      clearTimeout(flashTimer);
      flashTimer = 0;
      flashEl = null;
    }
    unsubLoadingReset();
    for (const unsub of unsubscribers) {
      unsub();
    }
    unsubscribers.length = 0;
    heightCache.clear();
    tree = null;
    releaseTrackedMedia();
    if (region !== null) {
      region.remove();
      region = null;
    }
    root = null;
    contentContainer = null;
    topSpacer = null;
    bottomSpacer = null;
    scrollToBottomBtn = null;
    jumpToPresentPill = null;
  }

  function scrollToMessage(messageId: number): boolean {
    if (root === null) return false;
    const idx = virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
    if (idx === -1) return false;

    root.scrollTop = offsetBefore(idx);
    // Force the rebuild path: a scroll-driven renderWindow only moves spacers,
    // so without this the target row can sit outside the rendered window and
    // there is nothing to flash (and nothing to look at after the scroll).
    renderedStart = -1;
    renderWindow();

    // renderWindow's own rapid-rebuild breaker can return before reassigning
    // renderedStart (it stays -1, the value forced above) when too many
    // rebuilds have fired in the last 2s. When that happens the DOM was never
    // rebuilt for this target — report a failed jump rather than computing a
    // localIdx against a sentinel and flashing/reporting success for a row
    // that never rendered. This lets callers (e.g. MessageJump) fall back to
    // fetching the around-window instead of treating this as a landed jump.
    if (renderedStart < 0) return false;

    // Briefly highlight the target message element
    if (contentContainer !== null) {
      const localIdx = idx - renderedStart;
      const el = contentContainer.children[localIdx] as HTMLElement | undefined;
      if (el !== undefined) {
        // A prior flash still pending (rapid repeat jumps) must not linger on
        // its now-stale row, and must not leave its timer live once replaced.
        if (flashTimer !== 0) {
          clearTimeout(flashTimer);
          flashEl?.classList.remove("highlight-flash");
        }
        el.classList.add("highlight-flash");
        flashEl = el;
        flashTimer = window.setTimeout(() => {
          el.classList.remove("highlight-flash");
          flashTimer = 0;
          flashEl = null;
        }, 1500);
      }
    }

    return true;
  }

  return { mount, destroy, scrollToMessage };
}
