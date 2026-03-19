/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { createElement, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { messagesStore, getChannelMessages, hasMoreMessages } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore } from "@stores/members.store";
import {
  shouldGroup,
  isSameDay,
  renderDayDivider,
  renderMessage,
} from "./message-list/renderers";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly currentUserId: number;
  readonly onScrollTop: () => void;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  readonly onDeleteClick: (messageId: number) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
}

// -- Constants ----------------------------------------------------------------

const SCROLL_TOP_THRESHOLD = 50;
const SCROLL_BOTTOM_THRESHOLD = 100;

/** Number of items to render beyond visible viewport in each direction. */
const OVERSCAN = 20;

/** Estimated pixel height per row (message or day divider) for initial layout. */
const ESTIMATED_ROW_HEIGHT = 52;

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

type VirtualItem = VirtualItemMessage | VirtualItemDivider;

// -- Pre-process messages into virtual items ----------------------------------

function buildVirtualItems(messages: readonly Message[]): readonly VirtualItem[] {
  const items: VirtualItem[] = [];
  let lastTimestamp: string | null = null;
  let prevMsg: Message | null = null;

  for (const msg of messages) {
    if (lastTimestamp === null || !isSameDay(lastTimestamp, msg.timestamp)) {
      items.push({ kind: "divider", timestamp: msg.timestamp });
    }
    const isGrouped = prevMsg !== null && shouldGroup(prevMsg, msg);
    items.push({ kind: "message", message: msg, isGrouped });
    lastTimestamp = msg.timestamp;
    prevMsg = msg;
  }
  return items;
}

// -- Factory ------------------------------------------------------------------

export type MessageListComponent = MountableComponent & {
  /** Scroll to a message by ID. Returns false if the message is not in the loaded window. */
  scrollToMessage(messageId: number): boolean;
};

export function createMessageList(options: MessageListOptions): MessageListComponent {
  const ac = new AbortController();
  const unsubscribers: Array<() => void> = [];
  let root: HTMLDivElement | null = null;
  let wasAtBottom = true;

  // Virtual scroll state
  let virtualItems: readonly VirtualItem[] = [];
  let allMessages: readonly Message[] = [];
  const heightCache = new Map<string, number>(); // itemKey → measured px
  let topSpacer: HTMLDivElement | null = null;
  let bottomSpacer: HTMLDivElement | null = null;
  let contentContainer: HTMLDivElement | null = null;
  let renderedStart = 0;
  let renderedEnd = 0;

  // ---------------------------------------------------------------------------
  // Height estimation
  // ---------------------------------------------------------------------------

  function itemKey(index: number): string {
    const item = virtualItems[index];
    if (item === undefined) return `idx-${index}`;
    if (item.kind === "divider") return `div-${item.timestamp}`;
    return `msg-${item.message.id}`;
  }

  function getItemHeight(index: number): number {
    return heightCache.get(itemKey(index)) ?? ESTIMATED_ROW_HEIGHT;
  }

  function totalHeight(): number {
    let h = 0;
    for (let i = 0; i < virtualItems.length; i++) {
      h += getItemHeight(i);
    }
    return h;
  }

  function offsetToIndex(scrollTop: number): number {
    let offset = 0;
    for (let i = 0; i < virtualItems.length; i++) {
      const h = getItemHeight(i);
      if (offset + h > scrollTop) return i;
      offset += h;
    }
    return virtualItems.length - 1;
  }

  function offsetBefore(index: number): number {
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

  // ---------------------------------------------------------------------------
  // Render visible window
  // ---------------------------------------------------------------------------

  function measureRendered(): void {
    if (contentContainer === null) return;
    const children = contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const globalIdx = renderedStart + i;
      const el = children[i] as HTMLElement;
      const h = el.offsetHeight;
      if (h > 0) {
        heightCache.set(itemKey(globalIdx), h);
      }
    }
  }

  function renderWindow(): void {
    if (root === null || contentContainer === null || topSpacer === null || bottomSpacer === null) return;

    const scrollTop = root.scrollTop;
    const clientHeight = root.clientHeight;

    if (virtualItems.length === 0) {
      clearChildren(contentContainer);
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

    // Skip re-render if the range hasn't changed
    if (start === renderedStart && end === renderedEnd) return;

    // Measure current elements before replacing
    measureRendered();

    renderedStart = start;
    renderedEnd = end;

    // Rebuild content
    clearChildren(contentContainer);
    const fragment = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const item = virtualItems[i]!;
      if (item.kind === "divider") {
        fragment.appendChild(renderDayDivider(item.timestamp));
      } else {
        fragment.appendChild(
          renderMessage(item.message, item.isGrouped, allMessages, options, ac.signal),
        );
      }
    }
    contentContainer.appendChild(fragment);

    // Set spacer heights
    topSpacer.style.height = `${offsetBefore(start)}px`;

    let bottomHeight = 0;
    for (let i = end; i < virtualItems.length; i++) {
      bottomHeight += getItemHeight(i);
    }
    bottomSpacer.style.height = `${bottomHeight}px`;

    // Measure newly rendered elements
    measureRendered();
  }

  // ---------------------------------------------------------------------------
  // Full rebuild (on data change)
  // ---------------------------------------------------------------------------

  function rebuildItems(): void {
    allMessages = getChannelMessages(options.channelId);
    virtualItems = buildVirtualItems(allMessages);
  }

  /** Render all items temporarily to measure their actual heights, then
   *  restore the normal virtual window. This eliminates the first-scroll
   *  jump caused by estimated heights differing from measured ones. */
  function premeasureAll(): void {
    if (contentContainer === null || virtualItems.length === 0) return;
    clearChildren(contentContainer);
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < virtualItems.length; i++) {
      const item = virtualItems[i]!;
      if (item.kind === "divider") {
        fragment.appendChild(renderDayDivider(item.timestamp));
      } else {
        fragment.appendChild(
          renderMessage(item.message, item.isGrouped, allMessages, options, ac.signal),
        );
      }
    }
    contentContainer.appendChild(fragment);
    // Measure all
    const children = contentContainer.children;
    for (let i = 0; i < children.length; i++) {
      const h = (children[i] as HTMLElement).offsetHeight;
      if (h > 0) heightCache.set(itemKey(i), h);
    }
    // Restore virtual window
    renderedStart = -1;
    renderedEnd = -1;
    clearChildren(contentContainer);
    renderWindow();
  }

  function renderAll(): void {
    if (root === null) return;
    wasAtBottom = isNearBottom();

    rebuildItems();

    // Reset rendered range to force full re-render
    renderedStart = -1;
    renderedEnd = -1;

    renderWindow();

    if (wasAtBottom) {
      scrollToBottom();
    }
  }

  // ---------------------------------------------------------------------------
  // Scroll / load-more handling
  // ---------------------------------------------------------------------------

  let loadingOlder = false;
  let prevMessageCount = 0;

  const unsubLoadingReset = messagesStore.subscribe(() => {
    const msgs = getChannelMessages(options.channelId);
    if (msgs.length !== prevMessageCount) {
      prevMessageCount = msgs.length;
      loadingOlder = false;
    }
  });

  let scrollRafId = 0;

  function handleScroll(): void {
    if (root === null) return;

    // Load older messages when near top
    if (
      root.scrollTop < SCROLL_TOP_THRESHOLD
      && !loadingOlder
      && hasMoreMessages(options.channelId)
    ) {
      loadingOlder = true;
      options.onScrollTop();
    }

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
    root = createElement("div", { class: "messages-container" });

    topSpacer = createElement("div", { class: "virtual-spacer-top" });
    contentContainer = createElement("div", { class: "virtual-content" });
    bottomSpacer = createElement("div", { class: "virtual-spacer-bottom" });
    const scrollAnchor = createElement("div", { class: "scroll-anchor" });

    root.appendChild(topSpacer);
    root.appendChild(contentContainer);
    root.appendChild(bottomSpacer);
    root.appendChild(scrollAnchor);

    root.addEventListener("scroll", handleScroll, {
      signal: ac.signal,
      passive: true,
    });

    // Watch for height changes in rendered items (images loading, embeds expanding).
    // Re-measure heights and update spacers. The CSS scroll-anchor element handles
    // pin-to-bottom automatically; for "scrolled up" we preserve distance-from-bottom.
    const resizeObserver = new ResizeObserver(() => {
      if (root === null || contentContainer === null) return;
      // Capture scroll position relative to the bottom (stable reference point)
      const distFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      measureRendered();
      // Update spacer heights with new measurements
      if (topSpacer !== null) topSpacer.style.height = `${offsetBefore(renderedStart)}px`;
      if (bottomSpacer !== null) {
        let bh = 0;
        for (let i = renderedEnd; i < virtualItems.length; i++) bh += getItemHeight(i);
        bottomSpacer.style.height = `${bh}px`;
      }
      // Restore scroll position (distance from bottom stays the same)
      if (distFromBottom > SCROLL_BOTTOM_THRESHOLD) {
        root.scrollTop = root.scrollHeight - root.clientHeight - distFromBottom;
      }
    });
    resizeObserver.observe(contentContainer);
    ac.signal.addEventListener("abort", () => resizeObserver.disconnect());

    parentContainer.appendChild(root);

    renderAll();
    // Pre-measure all items to warm the height cache so scrolling up
    // doesn't cause jumps from estimate→measured height corrections.
    premeasureAll();
    scrollToBottom();
    requestAnimationFrame(() => scrollToBottom());

    unsubscribers.push(messagesStore.subscribe(() => { renderAll(); }));

    // Only re-render when member roles change, not on typing updates
    let prevMembers = membersStore.getState().members;
    unsubscribers.push(membersStore.subscribe((state) => {
      if (state.members !== prevMembers) {
        prevMembers = state.members;
        renderAll();
      }
    }));
  }

  function destroy(): void {
    ac.abort();
    if (scrollRafId !== 0) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = 0;
    }
    unsubLoadingReset();
    for (const unsub of unsubscribers) { unsub(); }
    unsubscribers.length = 0;
    heightCache.clear();
    if (root !== null) { root.remove(); root = null; }
    contentContainer = null;
    topSpacer = null;
    bottomSpacer = null;
  }

  function scrollToMessage(messageId: number): boolean {
    if (root === null) return false;
    const idx = virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
    if (idx === -1) return false;

    root.scrollTop = offsetBefore(idx);
    renderWindow();

    // Briefly highlight the target message element
    if (contentContainer !== null) {
      const localIdx = idx - renderedStart;
      const el = contentContainer.children[localIdx] as HTMLElement | undefined;
      if (el !== undefined) {
        el.classList.add("highlight-flash");
        setTimeout(() => { el.classList.remove("highlight-flash"); }, 1500);
      }
    }

    return true;
  }

  return { mount, destroy, scrollToMessage };
}
