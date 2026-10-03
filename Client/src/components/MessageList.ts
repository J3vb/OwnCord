/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { Disposable } from "@lib/disposable";
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
import { safetyStore } from "../features/safety/store";
import { registerReadingAnchor } from "../features/messaging/readingAnchor";
import { uiStore } from "@stores/ui.store";
import { unobserveMedia } from "@lib/media-visibility";

const log = createLogger("message-list");
import {
  shouldGroup,
  isSameDay,
  renderDayDivider,
  renderNewDivider,
  renderMessage,
  authorAvatarKey,
  refreshConnectionControls,
} from "./message-list/renderers";
import { createAvatarElement } from "./message-list/avatar";
import { refreshReactionLocks } from "./message-list/reactions";
import { clearContentParseCache, resyncMentions } from "./message-list/content-parser";
import { highlightsCurrentUser } from "@lib/mentions";
import { canManageMessages } from "@lib/permissions";
import { readableRoleColor } from "@lib/themes";
import { resolveDisplayName } from "@lib/avatar";
import { channelsStore, getUnreadOnOpen } from "@stores/channels.store";
import {
  UNREAD_COUNT_CAP,
  atEachMidnight,
  formatMessageTimestamp,
  getUserRole,
  resolveAuthor,
  roleColorVar,
} from "@lib/formatting";
import { isAudioMime, isVideoMime } from "./message-list/attachments";
import { FenwickTree } from "./message-list/fenwick";
import { messagingText } from "../i18n/messaging";
import { markChannelRead, hasUnread, isChannelAway } from "@lib/read-state";

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
  readonly onDeleteClick: (messageId: number, shiftKey: boolean) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
  /** Report someone else's message or one of its attachments (B9-10). No button without it. */
  readonly onReportClick?: (messageId: number) => void;
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
/** Older history starts loading this many viewport heights before the top
 *  (DP-46), so the next page is usually in before the reader gets there. */
const SCROLL_TOP_VIEWPORTS = 2;
/** After a failed older-page fetch, scrolling inside the trigger zone waits
 *  this long before retrying, unless the reader leaves the zone first. */
const OLDER_RETRY_COOLDOWN_MS = 5000;
const SCROLL_BOTTOM_THRESHOLD = 100;

/** Number of items to render beyond visible viewport in each direction. */
const OVERSCAN = 20;

/** Controls a keyboard user can land on inside a rendered row. */
const ROW_FOCUSABLE_SELECTOR = "button, [tabindex='0'], a[href]";

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

/** Build virtual items for `messages`, with the NEW divider above index
 *  `newDividerAt` (-1 for none). */
function buildVirtualItems(
  messages: readonly Message[],
  newDividerAt: number,
): readonly VirtualItem[] {
  const items: VirtualItem[] = [];
  let lastTimestamp: string | null = null;
  let prevMsg: Message | null = null;

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
  title.textContent = isDm
    ? channelName
    : messagingText("welcome.channel", { channel: channelName });

  const text = createElement("p", { class: "channel-welcome-text" });
  text.textContent = isDm
    ? messagingText("welcome.dmIntro", { name: channelName })
    : messagingText("welcome.channelIntro", { channel: channelName });

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
  text.textContent = messagingText("loading");
  wrapper.appendChild(text);
  return wrapper;
}

/** In-region inline error + Retry when the first-page history fetch failed. */
function renderLoadErrorState(onRetryLoad?: () => void): HTMLDivElement {
  const wrapper = createElement("div", { class: "messages-load-error" });
  const text = createElement("p", { class: "messages-load-error-text" });
  text.textContent = messagingText("loadFailed");
  wrapper.appendChild(text);
  const retry = createElement("button", {
    class: "messages-retry-btn",
    "data-testid": "messages-retry",
  });
  retry.textContent = messagingText("retry");
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
  const disposable = new Disposable();
  const unsubscribers: Array<() => void> = [];
  /**
   * One owner per rendered message row, scoping that row's listeners (react/
   * reply/pin/edit/delete/copy-link, reply-ref, reaction chips, ...). A row
   * discarded by a rebuild or replaced by a row patch has its owner destroyed
   * at once, so its listeners never outlive it — every row used to register
   * against `disposable.signal` directly, retaining a full window of detached
   * rows (and everything they reference: videos, images, embeds, tooltips)
   * per rebuild (OC-0286). destroy() releases the rest.
   */
  const rowOwners = new Map<HTMLElement, Disposable>();
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
  /** The signed-in user's MANAGE_MESSAGES state at the last roleRevision, so a
   *  role change that flips it (which can add or remove a row's delete/pin
   *  controls) still rebuilds, while a rename or a plain repaint does not. */
  let lastCanManageMessages = false;

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
   *
   * A count at UNREAD_COUNT_CAP is only a lower bound, so it reads as "every
   * loaded message is unread": the divider stays at the top of the loaded
   * window as older history is prepended and never latches to a count-derived
   * row that could leave real unread messages above it.
   */
  const openedUnread = isWindowDetached(options.channelId) ? 0 : getUnreadOnOpen(options.channelId);
  const unreadOnOpen = openedUnread >= UNREAD_COUNT_CAP ? Infinity : openedUnread;

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
  /** Set while the divider waits for a revisit's refetched tail. */
  let newDividerDeferred = false;

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
    if (newDividerAnchorId !== null) {
      return messages.findIndex((m) => m.id === newDividerAnchorId);
    }
    // A revisit renders the cached window while its tail is refetched (DP-10).
    // Those rows predate what arrived while away, so counting back from their
    // end would mark messages already read; wait for the fetched tail.
    newDividerDeferred = unreadOnOpen > 0 && getHistoryLoadState(options.channelId) === "loading";
    if (newDividerDeferred) return -1;
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
    const owner = new Disposable();
    const el = renderMessage(item.message, item.isGrouped, allMessages, options, owner.signal);
    rowOwners.set(el, owner);
    return el;
  }

  /** Discard one rendered row: stop tracking its media and abort its listeners. */
  function releaseRow(el: HTMLElement): void {
    for (const img of el.querySelectorAll("img")) unobserveMedia(img);
    rowOwners.get(el)?.destroy();
    rowOwners.delete(el);
    el.remove();
  }

  function itemKey(index: number): string {
    return keyOf(virtualItems[index], index);
  }

  function keyOf(item: VirtualItem | undefined, index: number): string {
    if (item === undefined) return `idx-${index}`;
    if (item.kind === "divider") return `div-${item.timestamp}`;
    if (item.kind === "new-divider") return "new-divider";
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

  /**
   * P4-03 step A: the channel is read once the reader has seen its bottom with
   * the window focused. Fires on every scroll and on window focus; the
   * hasUnread gate keeps a plain scroll from spending the server's 5/s
   * mark_read budget, and the bottom of a detached window is not the present
   * (OC-0204), so that case is excluded too (isChannelAway, lib/read-state.ts).
   * The bottom-in-view check alone also covers focus returning while the reader
   * is scrolled up.
   */
  function markReadIfSeen(): void {
    if (root === null) return;
    if (channelsStore.getState().activeChannelId !== options.channelId) return;
    if (!isNearBottom()) return;
    if (isChannelAway(options.channelId)) return;
    if (!hasUnread(options.channelId)) return;
    markChannelRead(options.channelId);
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
      contentContainer === null ||
      !contentContainer.contains(active)
    ) {
      return null;
    }
    const row = active.closest<HTMLElement>("[data-testid]");
    const index =
      row === null ? -1 : [...row.querySelectorAll(ROW_FOCUSABLE_SELECTOR)].indexOf(active);
    return { own: active.dataset.testid ?? null, row: row?.dataset.testid ?? null, index };
  }

  function restoreRowFocus(
    captured: { own: string | null; row: string | null; index: number } | null,
  ): void {
    if (captured === null || contentContainer === null) return;
    if (captured.own !== null) {
      contentContainer
        .querySelector<HTMLElement>(`[data-testid="${captured.own}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    if (captured.row !== null && captured.index >= 0) {
      contentContainer
        .querySelector<HTMLElement>(`[data-testid="${captured.row}"]`)
        ?.querySelectorAll<HTMLElement>(ROW_FOCUSABLE_SELECTOR)
        .item(captured.index)
        ?.focus({ preventScroll: true });
    }
  }

  /** Abort every rendered row's listeners before a rebuild discards the rows,
   *  so a stale row can never outlive the render that replaced it (OC-0286).
   *  The row patch (patchRows) releases only the rows it replaces. */
  function beginRowRender(): void {
    for (const owner of rowOwners.values()) owner.destroy();
    rowOwners.clear();
  }

  let renderWindowCount = 0;
  let renderWindowResetTimer = 0;
  // Set when the breaker below drops a rebuild. Like renderAllSuppressed, the
  // 2s reset replays renderWindow once, so a fast scrollbar drag that trips it
  // still ends with the rows for where it stopped (DP-12). Once per burst, not
  // per dropped call, so the image-height oscillation it stops cannot restart.
  let renderWindowSuppressed = false;

  function renderWindow(): void {
    if (root === null || contentContainer === null || topSpacer === null || bottomSpacer === null)
      return;

    const scrollTop = root.scrollTop;
    const clientHeight = root.clientHeight;

    if (virtualItems.length === 0) {
      releaseTrackedMedia();
      beginRowRender();
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
        if (!renderWindowSuppressed) {
          log.error("[MessageList] renderWindow REBUILD called >30 times in 2s — breaking loop");
        }
        renderWindowSuppressed = true;
        return;
      }
      if (renderWindowResetTimer === 0) {
        renderWindowResetTimer = window.setTimeout(() => {
          renderWindowCount = 0;
          renderWindowResetTimer = 0;
          if (renderWindowSuppressed) {
            renderWindowSuppressed = false;
            renderWindow();
          }
        }, 2000);
      }

      // Full rebuild: requested by renderAll, or the window is following a
      // scroll into a region that is not rendered yet.
      log.debug("renderWindow REBUILD", { start, end });

      // Measure current elements before replacing.
      measureRendered();

      renderedStart = start;
      renderedEnd = end;

      // Rebuild content. The focused row's control is about to be detached by
      // clearChildren; capture its identity so it can be restored on its
      // replacement row (Q1: focus stays put through a virtualized rebuild).
      const focusedRow = captureRowFocus();
      releaseTrackedMedia();
      beginRowRender();
      clearChildren(contentContainer);
      const fragment = document.createDocumentFragment();
      for (let i = start; i < end; i++) {
        fragment.appendChild(renderVirtualItem(virtualItems[i]!));
      }
      contentContainer.appendChild(fragment);

      // Measure newly rendered elements and update spacers
      measureRendered();
      updateSpacers();
      restoreRowFocus(focusedRow);
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
    virtualItems = buildVirtualItems(allMessages, resolveNewDividerIndex(allMessages));

    seedTree();
  }

  /** Build the Fenwick tree from measured heights, estimating the rest. */
  function seedTree(): void {
    tree = new FenwickTree(virtualItems.length);
    for (let i = 0; i < virtualItems.length; i++) tree.set(i, getItemHeight(i));
  }

  // ---------------------------------------------------------------------------
  // Row-level patch (fast path)
  // ---------------------------------------------------------------------------

  /** Cap on rendered rows for the patch path. Once the window grows past
   *  this, fall back to renderAll so it is re-trimmed to the visible range. */
  const MAX_INCREMENTAL_WINDOW = 200;

  /**
   * Fast path for a store update that changes a few rows (P4-01): diff the new
   * items against the rendered ones by key and touch only what changed — a
   * reaction, edit, delete or send confirmation re-renders its own row, plus a
   * neighbour whose grouping changed and any loaded reply whose quoted
   * parent arrived, left or changed text, author or deletion. Rows dropped from the head, rows appended at the tail (a
   * revisit's refetched page, R1) and the NEW divider landing (R2) are
   * inserted or removed one by one. Every other row keeps its DOM node, so a
   * playing video, a revealed spoiler or focus survive. A row outside the
   * rendered window only moves its height entry.
   *
   * Returns false, for renderAll to rebuild, when there is nothing rendered to
   * keep, rows were reordered, or a message was inserted above every row that
   * stays (a history prepend, whose reading position renderAll keeps).
   *
   * The Fenwick tree is re-seeded from the height cache, as for any rebuild,
   * and the topmost visible message row that stays keeps its offset in the
   * viewport. The renderWindow oscillation guard is not consumed — this path
   * never rebuilds.
   */
  function patchRows(): boolean {
    if (root === null || contentContainer === null || tree === null) return false;
    if (renderAllRunning || renderedStart < 0 || allMessages.length === 0) return false;
    const next = getChannelMessages(options.channelId);
    if (next.length === 0) return false;
    const prevItems = virtualItems;
    const nextItems = buildVirtualItems(next, resolveNewDividerIndex(next));
    const prevKeys = prevItems.map(keyOf);
    const nextKeys = nextItems.map(keyOf);
    const prevIndex = new Map(prevKeys.map((k, i) => [k, i]));
    const nextIndex = new Map(nextKeys.map((k, i) => [k, i]));
    if (prevIndex.size < prevKeys.length || nextIndex.size < nextKeys.length) return false;

    // The rows that stay keep their order, and no message lands above every
    // message that stays (a history prepend, left to renderAll).
    let last = -1;
    let anchored = false;
    for (const [j, item] of nextItems.entries()) {
      const i = prevIndex.get(nextKeys[j]!);
      if (i === undefined) {
        if (!anchored && item.kind === "message") return false;
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
    for (let i = renderedStart; i < renderedEnd; i++) {
      const j = nextIndex.get(prevKeys[i]!);
      if (j === undefined) continue;
      if (start === -1) start = j;
      end = j + 1;
    }
    if (start === -1) return false;
    if (renderedStart === 0) start = 0;
    if (renderedEnd === prevItems.length) end = nextItems.length;
    if (end - start > MAX_INCREMENTAL_WINDOW) return false;

    const atBottom = isNearBottom();
    // Record the rendered rows' heights under their current keys before the
    // items change, and the topmost visible message row that stays as the
    // anchor: a divider is no anchor, since the NEW line can move.
    measureRendered();
    let anchor = offsetToIndex(root.scrollTop);
    while (
      anchor < prevItems.length &&
      (prevItems[anchor]!.kind !== "message" || !nextIndex.has(prevKeys[anchor]!))
    ) {
      anchor++;
    }
    const anchorKey = prevKeys[anchor];
    const anchorOffset = root.scrollTop - offsetBefore(anchor);

    // A reply re-renders its quote when its parent left, arrived, or changed
    // what the quote draws (renderReplyRef reads the parent from allMessages);
    // a reaction or pin on the parent leaves the reply alone.
    const prevById = new Map(allMessages.map((m) => [m.id, m]));
    const nextById = new Map(next.map((m) => [m.id, m]));
    const quoteChanged = (id: number | null): boolean => {
      if (id === null) return false;
      const a = prevById.get(id);
      const b = nextById.get(id);
      return a?.content !== b?.content || a?.deleted !== b?.deleted || a?.user !== b?.user;
    };

    const focused = captureRowFocus();
    const shown = [...contentContainer.children] as HTMLElement[];
    const shownByKey = new Map(shown.map((el, i) => [prevKeys[renderedStart + i]!, el]));
    allMessages = next;
    virtualItems = nextItems;

    const rows: HTMLElement[] = [];
    const reused = new Set<HTMLElement>();
    for (let j = start; j < end; j++) {
      const now = nextItems[j]!;
      const el = shownByKey.get(nextKeys[j]!);
      const was = el && prevItems[prevIndex.get(nextKeys[j]!)!];
      // A row stays when nothing it draws changed: its message, its grouping
      // and the parent a reply quotes. A divider with the same key is the same.
      const same =
        now.kind !== "message" ||
        (was?.kind === "message" &&
          was.message === now.message &&
          was.isGrouped === now.isGrouped &&
          !quoteChanged(now.message.replyTo));
      if (el !== undefined && same) {
        rows.push(el);
        reused.add(el);
      } else {
        rows.push(renderVirtualItem(now));
      }
    }
    for (const el of shown) {
      if (!reused.has(el)) releaseRow(el);
    }
    // The reused rows are already in order; slot the new ones in around them.
    let cursor = contentContainer.firstElementChild;
    for (const el of rows) {
      if (el === cursor) cursor = cursor.nextElementSibling;
      else contentContainer.insertBefore(el, cursor);
    }
    renderedStart = start;
    renderedEnd = end;

    seedTree();
    measureRendered();
    updateSpacers();
    if (focused !== null && !contentContainer.contains(document.activeElement)) {
      restoreRowFocus(focused);
    }

    if (atBottom) {
      scrollToBottom();
      updateScrollToBottomBtn();
    } else if (anchorKey !== undefined) {
      root.scrollTop = Math.max(0, offsetBefore(nextIndex.get(anchorKey)!) + anchorOffset);
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

  /** Index of the topmost message row in the viewport, or -1 when there is
   *  none that can be re-found after a rebuild. */
  function topMessageIndex(): number {
    if (root === null || virtualItems.length === 0) return -1;
    let idx = offsetToIndex(root.scrollTop);
    // The topmost item may be a day divider or the NEW divider, neither of
    // which has an identity that survives a rebuild — walk forward to the
    // message row that follows it (every divider is immediately followed by
    // one).
    while (idx < virtualItems.length && virtualItems[idx]!.kind !== "message") idx++;
    const item = virtualItems[idx];
    // id 0 is the unconfirmed-optimistic-row sentinel (see itemKey above) —
    // not unique across pending sends, so it cannot identify a specific row.
    return item?.kind === "message" && item.message.id !== 0 ? idx : -1;
  }

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
      if (!wasAtBottom && root !== null) {
        const anchorIdx = topMessageIndex();
        if (anchorIdx !== -1) {
          anchorMessageId = (virtualItems[anchorIdx] as VirtualItemMessage).message.id;
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
  let olderRetryAt = 0;
  /** Spinner row at the top of the history while an older page is in flight.
   *  Absolutely positioned in the scroller, so showing or hiding it never
   *  moves the rows (and never fires a scroll that could refetch). */
  let olderLoadingRow: HTMLDivElement | null = null;
  function setLoadingOlder(value: boolean): void {
    loadingOlder = value;
    if (!value) olderLoadingRow?.remove();
    else if (olderLoadingRow !== null) root?.appendChild(olderLoadingRow);
  }
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
        setLoadingOlder(false);
      }
    },
  );

  let scrollRafId = 0;
  let resizeRafId = 0;
  let resizeObserver: ResizeObserver | null = null;
  // resizeDirty tracking removed — resize observer batches via RAF directly
  function handleScroll(): void {
    if (root === null) return;

    // Load older messages well before the top (DP-46); the floor keeps the
    // trigger working when the viewport has no height yet.
    const nearTop =
      root.scrollTop < Math.max(SCROLL_TOP_THRESHOLD, root.clientHeight * SCROLL_TOP_VIEWPORTS);
    if (!nearTop) olderRetryAt = 0;
    if (
      nearTop &&
      !loadingOlder &&
      performance.now() >= olderRetryAt &&
      hasMoreMessages(options.channelId)
    ) {
      setLoadingOlder(true);
      const oldestAtFire = getChannelMessages(options.channelId)[0]?.id;
      // A failed fetch never changes the message count, so the subscriber
      // below (which only reacts to a count change) would leave loadingOlder
      // latched forever. Clear it once the load settles either way — the
      // subscriber's reset still applies to the success path but is now just
      // belt-and-braces.
      void Promise.resolve(options.onScrollTop()).finally(() => {
        setLoadingOlder(false);
        // Nothing was prepended: hold off so continued scrolling in the zone
        // does not send one failing request after another.
        if (getChannelMessages(options.channelId)[0]?.id === oldestAtFire) {
          olderRetryAt = performance.now() + OLDER_RETRY_COOLDOWN_MS;
        }
      });
    }

    // Update floating scroll-to-bottom button visibility
    updateScrollToBottomBtn();
    // Reaching the bottom counts as seeing it (P4-03 step A).
    markReadIfSeen();

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
    olderLoadingRow = createElement("div", {
      class: "messages-older-loading",
      role: "status",
      "aria-label": messagingText("loading"),
    });
    olderLoadingRow.appendChild(createElement("div", { class: "spinner" }));

    scrollToBottomBtn = createElement("button", {
      class: "scroll-to-bottom-btn",
      "aria-label": messagingText("scrollToBottom"),
    });
    scrollToBottomBtn.textContent = "↓";
    scrollToBottomBtn.addEventListener(
      "click",
      () => {
        scrollToBottom();
        updateScrollToBottomBtn();
      },
      { signal: disposable.signal },
    );

    jumpToPresentPill = createElement("button", {
      class: "jump-to-present-pill",
      "data-testid": "jump-to-present",
    });
    jumpToPresentPill.textContent = messagingText("jumpToPresent");
    jumpToPresentPill.addEventListener("click", () => options.onJumpToPresent?.(), {
      signal: disposable.signal,
    });

    root.appendChild(topSpacer);
    root.appendChild(contentContainer);
    root.appendChild(bottomSpacer);
    root.appendChild(scrollAnchor);
    region.appendChild(root);
    region.appendChild(scrollToBottomBtn);
    region.appendChild(jumpToPresentPill);

    root.addEventListener("scroll", handleScroll, {
      signal: disposable.signal,
      passive: true,
    });

    // Focus returning with the bottom already in view counts as seeing it
    // (P4-03 step A). Owned by disposable.signal so destroy() releases it.
    window.addEventListener("focus", markReadIfSeen, { signal: disposable.signal });

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
    disposable.signal.addEventListener("abort", () => cancelAnimationFrame(initialScrollRaf));

    // A full-ready resync refetches a detached window around this (P2-T4).
    unsubscribers.push(
      registerReadingAnchor((channelId) => {
        if (channelId !== options.channelId) return null;
        const idx = topMessageIndex();
        return idx === -1 ? null : (virtualItems[idx] as VirtualItemMessage).message.id;
      }),
    );

    unsubscribers.push(
      messagesStore.subscribeSelector(
        // Scoped to the mounted channel so updates to OTHER channels (their
        // array references are unchanged) never trigger a re-render here.
        (s) => s.messagesByChannel.get(options.channelId),
        () => {
          if (!patchRows()) {
            renderAll();
          }
        },
      ),
    );

    // Re-render the (empty) region when the first-page fetch transitions
    // between loading / error / idle. Shown rows are left alone: a revisit's
    // refetch finishing must not rebuild them (DP-10), and any change the
    // fetch made reaches the messagesByChannel subscriber above. A NEW divider
    // still waiting for that fetch is patched in on its own (R2).
    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.historyLoadState.get(options.channelId),
        () => {
          if (virtualItems.length === 0 || (newDividerDeferred && !patchRows())) renderAll();
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

    // A membership, role or profile (rename/avatar) change repaints only the
    // author identity of the rendered rows that changed, not the whole list
    // (P4-02, OC-0108). The store bumps roleRevision on every such mutation, so
    // selecting the counter avoids touching a role map per presence update.
    // The signed-in user's own role change can also change their per-row
    // affordances (pin/delete), so that case — and only it — falls back to a
    // rebuild.
    lastCanManageMessages = canManageMessages();
    unsubscribers.push(
      membersStore.subscribeSelector(
        (s) => s.roleRevision ?? 0,
        () => {
          const canManage = canManageMessages();
          if (canManage !== lastCanManageMessages) {
            lastCanManageMessages = canManage;
            renderAll();
          } else {
            refreshAuthorRows();
          }
        },
      ),
    );

    // A timeout starting or ending toggles the reaction controls' lock in place
    // (B9-15); no row is rebuilt, so video, spoilers and focus survive.
    unsubscribers.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
        () => {
          if (contentContainer !== null) refreshReactionLocks(contentContainer);
        },
      ),
    );

    // The delete action is disabled while the socket is down (CLI-08); flip the
    // gate on the rendered buttons in place, without a rebuild.
    unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => {
          if (contentContainer !== null) refreshConnectionControls(contentContainer);
        },
      ),
    );

    // "Today at …" becomes "Yesterday at …" when the local day turns, so the
    // rendered rows' relative times are relabelled in place once a day; rows
    // outside the window get fresh text when renderWindow builds them. Owned
    // by disposable.signal: destroy() releases the pending timer.
    atEachMidnight(disposable.signal, relabelRenderedTimes);

    // Switching the 12h/24h clock preference relabels the rendered rows in
    // place, the same way midnight does. Owned by disposable.signal, so the
    // listener dies with the component.
    window.addEventListener(
      "owncord:pref-change",
      ((e: CustomEvent<{ key: string }>) => {
        if (e.detail.key === "timeFormat") relabelRenderedTimes();
      }) as EventListener,
      { signal: disposable.signal },
    );
  }

  /**
   * Repaint author identity on the rendered rows whose author changed after a
   * members-store update, without rebuilding them (P4-02). A row stores the
   * key it was drawn from in `data-author-key`; only a differing key patches
   * that row's avatar, name and role colour, so a rename or a role change
   * touches the affected rows and a presence update touches none.
   */
  function refreshAuthorRows(): void {
    if (contentContainer === null || renderedStart < 0) return;
    const children = contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const item = virtualItems[renderedStart + i];
      if (item?.kind !== "message") continue;
      const el = children[i] as HTMLElement;
      // A reply's quoted author can change even when the row's own author did
      // not, so this runs for every row, not only the ones whose own key moved.
      repaintReplyRefAuthors(el);
      const msg = item.message;
      // @mention resolution depends on the live member store, so a rename or a
      // membership change must re-resolve it on every rendered row — including
      // rows that merely mention the renamed member, not just those it authored
      // — without re-parsing or rebuilding them (P4-02, F3). A system row draws
      // its mentions with no server info, so it resyncs the same way.
      if (el.classList.contains("message")) {
        const mentionInfo = { mentions: msg.mentions, mentionsEveryone: msg.mentionsEveryone };
        resyncMentions(el, mentionInfo);
        el.classList.toggle(
          "mentioned",
          !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo),
        );
      } else {
        resyncMentions(el);
      }
      const roleColor = roleColorVar(getUserRole(msg.user.id));
      const author = resolveAuthor(msg.user);
      const key = authorAvatarKey(author, roleColor);
      if (key === el.dataset["authorKey"]) continue;
      el.dataset["authorKey"] = key;
      const name = resolveDisplayName(author);
      const authorEl = el.querySelector<HTMLElement>(".msg-author");
      if (authorEl !== null) {
        authorEl.textContent = name;
        authorEl.title = author.username;
        authorEl.dataset["roleColor"] = roleColor;
        authorEl.style.color = readableRoleColor(roleColor);
      }
      const avatar = el.querySelector<HTMLElement>(".msg-avatar");
      if (avatar !== null) {
        avatar.replaceWith(
          createAvatarElement(author, { className: "msg-avatar", background: roleColor }),
        );
      }
    }
  }

  /**
   * Repaint the quoted author on every reply bar under `row` whose parent's
   * identity changed (a rename, avatar or role change), keyed by the same
   * `data-author-key`. The reply body text is left alone: it belongs to the
   * parent's message row, which the members-store update cannot change — only
   * a parent content edit does, and patchRows re-renders that row.
   */
  function repaintReplyRefAuthors(row: HTMLElement): void {
    for (const bar of row.querySelectorAll<HTMLElement>(".msg-reply-ref")) {
      const replyTo = Number(bar.dataset["replyTo"] ?? "0");
      const parent = allMessages.find((m) => m.id === replyTo);
      if (parent === undefined) continue;
      const roleColor = roleColorVar(getUserRole(parent.user.id));
      const author = resolveAuthor(parent.user);
      const key = authorAvatarKey(author, roleColor);
      if (key === bar.dataset["authorKey"]) continue;
      bar.dataset["authorKey"] = key;
      const name = resolveDisplayName(author);
      const authorEl = bar.querySelector<HTMLElement>(".rr-author");
      if (authorEl !== null) authorEl.textContent = name;
      const avatar = bar.querySelector<HTMLElement>(".rr-avatar");
      if (avatar !== null) {
        avatar.replaceWith(
          createAvatarElement(author, { className: "rr-avatar", background: roleColor }),
        );
      }
    }
  }

  function relabelRenderedTimes(): void {
    if (contentContainer === null || renderedStart < 0) return;
    const children = contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const item = virtualItems[renderedStart + i];
      if (item?.kind !== "message") continue;
      const text = formatMessageTimestamp(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll(".msg-time, .msg-hover-time, .sm-time")) {
        el.textContent = text;
      }
    }
  }

  function destroy(): void {
    if (resizeObserver !== null) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    disposable.destroy();
    beginRowRender();
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
    clearContentParseCache();
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
    olderLoadingRow = null;
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
