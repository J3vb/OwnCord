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
import { FenwickTree } from "./message-list/fenwick";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly currentUserId: number;
  readonly onScrollTop: () => void;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  readonly onDeleteClick: (messageId: number) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
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

type VirtualItem = VirtualItemMessage | VirtualItemDivider;

// -- Smart height estimation --------------------------------------------------

function estimateItemHeight(item: VirtualItem): number {
  if (item.kind === "divider") return 32;

  let height = item.isGrouped ? 42 : 72;

  // Image attachments
  for (const att of item.message.attachments) {
    if (att.mime.startsWith("image/")) {
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
  const heightCache = new Map<string, number>(); // itemKey -> measured px
  let tree: FenwickTree | null = null;
  let topSpacer: HTMLDivElement | null = null;
  let bottomSpacer: HTMLDivElement | null = null;
  let contentContainer: HTMLDivElement | null = null;
  let renderedStart = 0;
  let renderedEnd = 0;

  // ---------------------------------------------------------------------------
  // Height estimation (Fenwick tree backed)
  // ---------------------------------------------------------------------------

  function itemKey(index: number): string {
    const item = virtualItems[index];
    if (item === undefined) return `idx-${index}`;
    if (item.kind === "divider") return `div-${item.timestamp}`;
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
        const key = itemKey(globalIdx);
        heightCache.set(key, h);
        if (tree !== null && globalIdx < tree.size) {
          tree.set(globalIdx, h);
        }
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
    updateSpacers();

    // Measure newly rendered elements
    measureRendered();
  }

  // ---------------------------------------------------------------------------
  // Full rebuild (on data change)
  // ---------------------------------------------------------------------------

  function rebuildItems(): void {
    allMessages = getChannelMessages(options.channelId);
    virtualItems = buildVirtualItems(allMessages);

    // Build Fenwick tree initialized with smart estimates / cached heights
    tree = new FenwickTree(virtualItems.length);
    for (let i = 0; i < virtualItems.length; i++) {
      const cached = heightCache.get(itemKey(i));
      const h = cached !== undefined ? cached : estimateItemHeight(virtualItems[i]!);
      tree.set(i, h);
    }
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

  const unsubLoadingReset = messagesStore.subscribeSelector(
    (s) => s.messagesByChannel,
    () => {
      const msgs = getChannelMessages(options.channelId);
      if (msgs.length !== prevMessageCount) {
        prevMessageCount = msgs.length;
        loadingOlder = false;
      }
    },
  );

  let scrollRafId = 0;
  let resizeRafId = 0;
  let resizeDirty = false;

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
    // Batched via RAF with anchor-based scroll preservation.
    const resizeObserver = new ResizeObserver(() => {
      if (root === null || contentContainer === null) return;
      resizeDirty = true;
      if (resizeRafId !== 0) return;

      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        resizeDirty = false;
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
    ac.signal.addEventListener("abort", () => resizeObserver.disconnect());

    parentContainer.appendChild(root);

    renderAll();
    scrollToBottom();
    const initialScrollRaf = requestAnimationFrame(() => scrollToBottom());
    ac.signal.addEventListener("abort", () => cancelAnimationFrame(initialScrollRaf));

    unsubscribers.push(messagesStore.subscribeSelector(
      (s) => s.messagesByChannel,
      () => { renderAll(); },
    ));

    // Only re-render when member roles change, not on typing updates
    unsubscribers.push(membersStore.subscribeSelector(
      (s) => s.members,
      () => { renderAll(); },
    ));
  }

  function destroy(): void {
    ac.abort();
    if (scrollRafId !== 0) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = 0;
    }
    if (resizeRafId !== 0) {
      cancelAnimationFrame(resizeRafId);
      resizeRafId = 0;
    }
    unsubLoadingReset();
    for (const unsub of unsubscribers) { unsub(); }
    unsubscribers.length = 0;
    heightCache.clear();
    tree = null;
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
