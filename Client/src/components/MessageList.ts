/**
 * MessageList component — renders chat messages with grouping, day dividers,
 * role-colored usernames, @mention highlighting, infinite scroll, and
 * virtual scrolling (DOM windowing) for performance with large message counts.
 */
import { Disposable } from "@lib/disposable";
import { createElement, clearChildren, setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { isServerRowKind } from "@lib/text/messageKind";
import type { MountableComponent } from "@lib/text/safeRender";
import {
  messagesStore,
  getChannelMessages,
  hasMoreMessages,
  hasOlderLoadFailed,
  getHistoryLoadState,
  isWindowDetached,
} from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { blocksStore } from "@stores/blocks.store";
import { authorityChannelId, isReadSurface, threadsStore } from "@stores/threads.store";
import { refreshThreadChips } from "./message-list/threadChip";
import { safetyStore } from "../features/safety/store";
import { registerReadingAnchor } from "../features/messaging/readingAnchor";
import { openUserProfilePopup } from "../features/profiles/openUserProfilePopup";
import { uiStore } from "@stores/ui.store";
import { discardMedia } from "@lib/prefs/mediaVisibility";

/** How often rendered `<t:…:R>` timestamps are rewritten. */
const RELATIVE_TIMESTAMP_REFRESH_MS = 60_000;

const log = createLogger("message-list");
import {
  shouldGroup,
  isSameDay,
  renderBlockedRun,
  renderDayDivider,
  renderNewDivider,
  renderUnreadBar,
  renderMessage,
  authorAvatarKey,
  refreshConnectionControls,
  fullDateTimeTitle,
  type MessageRenderOptions,
} from "./message-list/renderers";
import { createAvatarElement, pickAvatarColor } from "./message-list/avatar";
import { refreshReactionLocks } from "./message-list/reactions";
import { ROW_FOCUSABLE_SELECTOR } from "./message-list/message-actions";
import { withMessageMenu } from "./message-list/message-menu-loader";
import { preloadInlineEdit, withInlineEdit } from "../features/messaging/inlineEditLoader";
import type { InlineEditSession } from "../features/messaging/inlineEdit";
import {
  clearContentParseCache,
  relabelInlineTimestamps,
  resyncMentions,
} from "./message-list/content-parser";
import { highlightsCurrentUser } from "@lib/text/mentions";
import { applyPickedMentions, tokensToPickedText } from "@lib/text/pickedMentions";
import { canManageMessages } from "@lib/permissions";
import { readableRoleColor } from "@lib/prefs/themes";
import { resolveDisplayName } from "@lib/avatar";
import { channelsStore, getPointerOnOpen, getUnreadOnOpen } from "@stores/channels.store";
import {
  UNREAD_COUNT_CAP,
  atEachMidnight,
  formatBadgeCount,
  formatClockTime,
  formatMessageTimestamp,
  resolveAuthor,
  userRoleColorVar,
} from "@lib/text/formatting";
import {
  isAudioMime,
  isGalleryImage,
  isImageMime,
  isVideoAttachment,
  resolveServerUrl,
  thumbnailUrl,
} from "./message-list/attachments";
import {
  ATTACHMENT_BOX_MAX_H,
  fitImageBox,
  getImageBox,
  knownImageHeight,
} from "./message-list/image-sizes";
import { extractUrls, isDirectImageUrl } from "./message-list/media";
import { FenwickTree } from "./message-list/fenwick";
import { rememberRowHeight, rememberedRowHeight, rowHeightKey } from "./message-list/row-heights";
import type { PollOutcome } from "../features/messaging/pollSend";
import { messagingText } from "../i18n/messaging";
import {
  markChannelRead,
  markChannelReadSeen,
  hasUnread,
  isHeldUnread,
  isChannelAway,
  isChannelCovered,
  noteLiveMessageSeen,
  noteMessageSeen,
  noteVisibleMessageSeen,
  onMarkUnreadFailed,
  setLiveTailInView,
} from "@lib/read-state";
import { idMentionsEnabled, readPointerEnabled } from "@lib/serverCapabilities";
import { markMessageUnread } from "./message-list/mark-unread";
import { onPrefChange } from "@lib/prefs/preferences";

// -- Options ------------------------------------------------------------------

export interface MessageListOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly channelType?: string;
  readonly currentUserId: number;
  /** May return a promise (e.g. the underlying fetch); MessageList clears its
   *  loadingOlder latch once it settles, success or failure. */
  readonly onScrollTop: () => void | Promise<void>;
  /**
   * Load the page of messages below a window detached from the live tail
   * (after a jump to an old message). Fired near the bottom of a detached
   * window only; may return a promise, which clears the in-flight latch once
   * it settles. The page that reaches the newest message reattaches the
   * window through the store. No paging below the window without it.
   */
  readonly onScrollBottom?: () => void | Promise<void>;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  /**
   * Save the inline editor's text (cleaned, non-empty, within the limit).
   * True closes the editor; false keeps it open with the text (offline).
   */
  readonly onEditSave: (messageId: number, content: string) => boolean;
  /** Save with the text cleared: the host offers to delete the message. */
  readonly onEmptyEdit: (messageId: number) => void;
  /** The inline editor closed while it held focus: hand focus back (the composer). */
  readonly onEditEnd?: () => void;
  readonly onDeleteClick: (messageId: number, shiftKey: boolean) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
  /** Report someone else's message or one of its attachments. No button without it. */
  readonly onReportClick?: (messageId: number) => void;
  /** Opens the Forward picker for a message. Absent, the menu offers no Forward. */
  readonly onForwardClick?: (messageId: number) => void;
  /** Set the viewer's whole selection on a poll (`[]` removes the vote); absent disables voting. */
  readonly onPollVote?: (
    messageId: number,
    answerIds: readonly number[],
  ) => Promise<PollOutcome<unknown>>;
  /** End a poll now; absent hides End poll. */
  readonly onPollEnd?: (messageId: number) => Promise<PollOutcome<unknown>>;
  /** Opens the Create Thread dialog for a message. Absent, the menu offers no Create Thread. */
  readonly onCreateThreadClick?: (messageId: number) => void;
  /** Opens a thread's side panel (the starter chip). Absent, the chip is inert text. */
  readonly onOpenThread?: (threadId: number) => void;
  /** Retry a failed optimistic send (by its correlation id). */
  readonly onRetry?: (correlationId: string) => void;
  /** Discard a failed optimistic send without retrying. */
  readonly onDeleteDraft?: (correlationId: string) => void;
  /** The upload strip of a send queued behind its files (3A-9), for the row with this
   *  correlation id; null when the row has none. `signal` ends with the row's render. */
  readonly renderUploadStrip?: (correlationId: string, signal: AbortSignal) => HTMLElement | null;
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
  /** Send the 👋 reply to a welcome row. Absent, the row has no Wave button. */
  readonly onWave?: (messageId: number) => boolean;
  /** Open the pinned-messages panel ("pinned messages" link of a pin row). It never closes an open panel. */
  readonly onOpenPins?: () => void;
  /** Join the DM call a live call log row stands for. No Join button without it. */
  readonly onJoinCall?: (channelId: number) => void;
}

// -- Constants ----------------------------------------------------------------

const SCROLL_TOP_THRESHOLD = 50;
/** Older history starts loading this many viewport heights before the top,
 *  so the next page is usually in before the reader gets there. */
const SCROLL_TOP_VIEWPORTS = 2;
/** Newer history (below a detached window) starts loading this many viewport
 *  heights before the bottom, mirroring SCROLL_TOP_VIEWPORTS. */
const SCROLL_BOTTOM_VIEWPORTS = 2;
/** After a failed older-page fetch, scrolling inside the trigger zone waits
 *  this long before retrying, unless the reader leaves the zone first. */
const OLDER_RETRY_COOLDOWN_MS = 5000;
/** How long a send waits for a detached window's tail reload before it stops
 *  pulling the reader to the bottom. */
const FOLLOW_OWN_SEND_MS = 10_000;
const SCROLL_BOTTOM_THRESHOLD = 100;
const JUMP_RECENTRE_MS = 3000;

const blockedUsers = (): ReadonlySet<number> => blocksStore.getState().blockedByMe;

/** The hover bar's "..." button the event came from, if any. */
function moreButtonOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".msg-actions-bar [data-testid^='msg-more-']")
    : null;
}

/** Headroom above the NEW divider on open: the unread bar overlays the top of the viewport. */
const UNREAD_BAR_CLEARANCE = 40;

/** Most items rendered beyond the visible range in each direction. Also the
 *  buffer when the viewport has no height yet (first paint, hidden tab). */
const OVERSCAN_MAX_ROWS = 20;
/** Fewest items kept beyond the visible range, so a list of tall rows still has
 *  something to scroll into. */
const OVERSCAN_MIN_ROWS = 4;
/** The render window reaches this many viewport heights above and below what is
 *  on screen, bounded by the row limits above. */
const OVERSCAN_VIEWPORTS = 1;

function clampOverscan(rows: number): number {
  return Math.min(OVERSCAN_MAX_ROWS, Math.max(OVERSCAN_MIN_ROWS, rows));
}

/** Regex for direct image URLs in message content. */
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?(?:\s|$)/i;

/** Regex for YouTube URLs in message content. */
const YOUTUBE_URL_RE =
  /(?:(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com\/(?:watch|embed\/|shorts\/|live\/)|youtu\.be\/)/i;

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

/** A run of consecutive messages by blocked authors: the header stands for it
 *  while collapsed, and sits above its messages while expanded. */
interface VirtualItemBlockedRun {
  readonly kind: "blocked-run";
  readonly firstId: number;
  readonly lastId: number;
  readonly count: number;
  readonly expanded: boolean;
}

export type VirtualItem =
  VirtualItemMessage | VirtualItemDivider | VirtualItemNewDivider | VirtualItemBlockedRun;

// -- Smart height estimation --------------------------------------------------

/** A message line: `.msg-text` is 1.45 x 15 px; the header line shares the
 *  first row's 44 px minimum with it. */
const TEXT_LINE_HEIGHT = 22;
/** Average glyph width of the message font, in px (a proportional sans). */
const AVERAGE_CHAR_WIDTH = 7.5;
/** Width of `.messages-container` assumed before a real one is measured, and
 *  what the row padding (`--message-content-left/right`) takes from it. */
const DEFAULT_LIST_WIDTH = 900;
const ROW_HORIZONTAL_PADDING = 120;
/** Margin above an inline image or attachment box. */
const MEDIA_MARGIN = 4;

/** Rows of text a message fills at `listWidth`: each source line wraps at the
 *  characters that fit; an empty line still takes one. */
function estimateTextLines(content: string, listWidth: number): number {
  const perLine = Math.max(
    8,
    Math.floor(Math.max(listWidth - ROW_HORIZONTAL_PADDING, 0) / AVERAGE_CHAR_WIDTH),
  );
  let lines = 0;
  for (const line of content.split("\n")) lines += Math.max(1, Math.ceil(line.length / perLine));
  return lines;
}

/** Height of an image box the list already knows: the server's dimensions,
 *  else the size remembered for its URL; undefined when neither exists. */
function knownAttachmentHeight(att: Message["attachments"][number]): number | undefined {
  if (att.width != null && att.height != null) {
    const box = fitImageBox(att.width, att.height, ATTACHMENT_BOX_MAX_H);
    if (box !== null) return box.h;
  }
  return knownImageHeight(thumbnailUrl(resolveServerUrl(att.url), att.mime));
}

/** Height of the mosaic `.msg-image-grid` makes for `count` tiles (messages.css):
 *  140 px rows, 200 px for exactly two, 4 px gaps and the 4 px margin above.
 *  The first row holds one tile (7, 10), two (the default) or fills the width. */
function galleryGridHeight(count: number): number {
  let rows: number;
  if (count === 2) rows = 1;
  else if (count === 3 || count === 4) rows = 2;
  else if (count === 6 || count === 9) rows = Math.ceil(count / 3);
  else if (count === 7 || count === 10) rows = 1 + Math.ceil((count - 1) / 3);
  else rows = 1 + Math.ceil((count - 2) / 3);
  const rowHeight = count === 2 ? 200 : 140;
  return rows * rowHeight + (rows - 1) * 4 + MEDIA_MARGIN;
}

export function estimateItemHeight(
  item: VirtualItem,
  listWidth: number = DEFAULT_LIST_WIDTH,
): number {
  if (item.kind !== "message") return 32;

  // Non-grouped: min-height 2.75rem (44px @16px root) + margin-top 17px = 61px
  // Grouped: min-height 1.375rem (22px @16px root) + margin-top 0px = 22px
  // Both hold one line of text; each further wrapped line adds one line height.
  let height = item.isGrouped ? 22 : 61;
  const { content } = item.message;
  height += (estimateTextLines(content, listWidth) - 1) * TEXT_LINE_HEIGHT;

  // Media attachments. Video shares the image box, so it reserves the same
  // space; the audio player is a chip-height row.
  // Two or more images share one mosaic, whatever their own sizes are.
  const tiles = item.message.attachments.filter(isGalleryImage);
  const gridded = tiles.length >= 2;
  if (gridded) height += galleryGridHeight(tiles.length);
  for (const att of item.message.attachments) {
    if (gridded && tiles.includes(att)) continue;
    if (isVideoAttachment(att)) {
      height += 220;
    } else if (isAudioMime(att.mime)) {
      height += 96;
    } else if (isImageMime(att.mime)) {
      const known = knownAttachmentHeight(att);
      height += known === undefined ? 220 : known + MEDIA_MARGIN;
    }
  }

  // Inline image URLs in content: the box measured for each URL, else 220.
  if (IMAGE_URL_RE.test(content)) {
    // The URLs renderUrlEmbeds draws (none inside code, masked links,
    // spoilers or angle brackets), one embed per distinct URL.
    const rowWidth = Math.max(listWidth - ROW_HORIZONTAL_PADDING, 1);
    for (const url of new Set(extractUrls(content).filter(isDirectImageUrl))) {
      const box = getImageBox(url);
      // The box shrinks with the row (max-width 100%), keeping its ratio.
      height +=
        box === undefined ? 220 : Math.round(box.h * Math.min(1, rowWidth / box.w)) + MEDIA_MARGIN;
    }
  }

  // YouTube embeds
  if (YOUTUBE_URL_RE.test(content)) {
    height += 320;
  }

  return height;
}

/**
 * What the list draws: the store keeps a deleted message as a tombstone (reply
 * checks and the echo reconcile need to know it was deleted), the view leaves it
 * out. Returns `list` itself when nothing is deleted.
 */
function visibleMessages(list: readonly Message[]): readonly Message[] {
  return list.some((m) => m.deleted) ? list.filter((m) => !m.deleted) : list;
}

/**
 * Focus the first control of the nearest row that survived a patch: the next
 * one below the removed row, else the one above. `rows` are the rendered rows
 * of the new window, from item index `start`.
 */
function focusSurvivingRow(
  prevKeys: readonly string[],
  nextIndex: ReadonlyMap<string, number>,
  rows: readonly HTMLElement[],
  start: number,
  prevStart: number,
  prevEnd: number,
  removedKey: string,
): void {
  const from = prevKeys.indexOf(removedKey);
  const survivor = (i: number): HTMLElement | undefined => {
    const j = nextIndex.get(prevKeys[i]!);
    if (j === undefined) return undefined;
    const el = rows[j - start];
    return el !== undefined && el.querySelector(ROW_FOCUSABLE_SELECTOR) !== null ? el : undefined;
  };
  for (let i = from + 1; i < prevEnd; i++) {
    const el = survivor(i);
    if (el !== undefined) {
      el.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
      return;
    }
  }
  for (let i = from - 1; i >= prevStart; i--) {
    const el = survivor(i);
    if (el !== undefined) {
      el.querySelector<HTMLElement>(ROW_FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
      return;
    }
  }
}

// -- Pre-process messages into virtual items ----------------------------------

/** Build virtual items for `messages`, with the NEW divider above index
 *  `newDividerAt` (-1 for none). Consecutive messages by an author in `blocked`
 *  become one run, broken by a day divider and by the NEW line; it is expanded
 *  when any of its ids is in `shown`. */
function buildVirtualItems(
  messages: readonly Message[],
  newDividerAt: number,
  blocked: ReadonlySet<number>,
  shown: ReadonlySet<number>,
): readonly VirtualItem[] {
  const items: VirtualItem[] = [];
  let lastTimestamp: string | null = null;
  let prevMsg: Message | null = null;
  let run: Message[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const expanded = run.some((m) => shown.has(m.id));
    items.push({
      kind: "blocked-run",
      firstId: run[0]!.id,
      lastId: run[run.length - 1]!.id,
      count: run.length,
      expanded,
    });
    if (expanded) {
      for (const message of run) items.push({ kind: "message", message, isGrouped: false });
    }
    run = [];
  };

  for (const [i, msg] of messages.entries()) {
    // A server row (call log, group event) is never folded into a blocked run.
    const isBlocked = blocked.has(msg.user.id) && !isServerRowKind(msg.kind);
    const newDay = lastTimestamp === null || !isSameDay(lastTimestamp, msg.timestamp);
    const isFirstUnread = i === newDividerAt;
    if (newDay || isFirstUnread || !isBlocked) flushRun();
    if (newDay) {
      items.push({ kind: "divider", timestamp: msg.timestamp });
    }
    if (isFirstUnread) {
      items.push({ kind: "new-divider" });
    }
    if (isBlocked) {
      run.push(msg);
      lastTimestamp = msg.timestamp;
      prevMsg = null;
      continue;
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
  flushRun();
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

/** Share of the visible height one PageUp/PageDown scrolls. */
const PAGE_SCROLL_FRACTION = 0.875;

export type MessageListComponent = MountableComponent & {
  /** Scroll to a message by ID. Returns false if the message is not in the loaded window. */
  scrollToMessage(messageId: number): boolean;
  /** Escape: mark the channel read, drop the unread bar and go back to the
   *  newest messages (a detached window jumps to the present). */
  markReadAndJumpToPresent(): void;
  /** PageUp/PageDown from the message box: scroll one page; 1 is down. */
  scrollPage(direction: 1 | -1): void;
  /**
   * Open the inline editor in your own sent message's row, with `text` (default
   * the message's current content). False when the message is not loaded, not
   * yours or not sent. The editor itself arrives a moment later (lazy chunk).
   */
  /** Open the inline editor on one of your sent messages. `focus: false`
   *  restores it quietly (no focus, no scrolling) for a late failed save. */
  startEdit(messageId: number, text?: string, opts?: { readonly focus?: boolean }): boolean;
  /** Close the open inline editor, discarding its text. */
  cancelEdit(): void;
  /** True while an inline editor is open (or loading) in this list. */
  isEditing(): boolean;
};

/** The scroll viewport's geometry. Reading it forces layout when the DOM is
 *  dirty, so a scroll frame reads it once and passes the result down. */
interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

function readMetrics(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}

export function createMessageList(options: MessageListOptions): MessageListComponent {
  const disposable = new Disposable();
  const unsubscribers: Array<() => void> = [];
  /** Message ids of blocked authors whose run the reader opened, for this mount. */
  const shownBlocked = new Set<number>();
  const renderOptions: MessageRenderOptions = {
    ...options,
    listSignal: disposable.signal,
    get blockedUsers() {
      return blockedUsers();
    },
  };
  /**
   * One owner per rendered message row, scoping that row's listeners (react/
   * reply/pin/edit/delete/copy-link, reply-ref, reaction chips, ...). A row
   * discarded by a rebuild or replaced by a row patch has its owner destroyed
   * at once, so its listeners never outlive it — every row used to register
   * against `disposable.signal` directly, retaining a full window of detached
   * rows (and everything they reference: videos, images, embeds, tooltips)
   * per rebuild. destroy() releases the rest.
   */
  const rowOwners = new Map<HTMLElement, Disposable>();
  /**
   * The open inline editor: at most one per list. `session` is null
   * while the lazy chunk loads; `gen` tells a late load that it was superseded.
   */
  let edit: { readonly messageId: number; session: InlineEditSession | null; gen: number } | null =
    null;
  let editGen = 0;
  // The editor held focus when its row was released by a window slide; it is
  // focused again when the row comes back.
  let editRefocus = false;
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
  /** Every loaded message, tombstones included: a reply resolves its parent
   *  here, so a parent deleted live reads as deleted, not as unknown. Only
   *  `allMessages` (the rows drawn) leaves tombstones out. */
  let replyParents: readonly Message[] = [];
  const heightCache = new Map<string, number>(); // itemKey -> measured px
  /** Width the unmeasured rows' text estimates wrap at; the real one once the
   *  ResizeObserver has seen the list. */
  let estimateWidth: number | undefined;
  let tree: FenwickTree | null = null;
  let topSpacer: HTMLDivElement | null = null;
  let bottomSpacer: HTMLDivElement | null = null;
  let contentContainer: HTMLDivElement | null = null;
  let scrollToBottomBtn: HTMLButtonElement | null = null;
  let unreadBar: HTMLDivElement | null = null;
  let unreadBarLabel: HTMLSpanElement | null = null;
  let unreadAnnouncer: HTMLDivElement | null = null;
  let unreadBarDismissed = false;
  /** The visit still owes the reader a jump to the NEW divider (cleared on first use). */
  let openAtDividerPending = false;
  let scrollToBottomCount: HTMLSpanElement | null = null;
  /** Messages from others that landed below the view since the reader scrolled up. */
  let newBelowCount = 0;
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
  let openedUnread = isWindowDetached(options.channelId) ? 0 : getUnreadOnOpen(options.channelId);
  let unreadOnOpen = openedUnread >= UNREAD_COUNT_CAP ? Infinity : openedUnread;
  /** True from the first Mark Unread here: the unread count the bar shows is the channel's now. */
  let markedUnread = false;
  /** The bottom was reached and marked since the reader last left it (or was away). */
  let bottomMarked = false;

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
   * The read pointer the NEW line follows, when the server keeps one: the one
   * the channel had when it was opened (a visit moves the live pointer), or
   * the one Mark Unread just set. The line goes on the first loaded message
   * above it. Undefined keeps the count-based line.
   */
  let linePointer: number | undefined = readPointerEnabled()
    ? getPointerOnOpen(options.channelId)
    : undefined;
  /** Set while the divider waits for a revisit's refetched tail. */
  let newDividerDeferred = false;
  /** The loaded-and-empty welcome state is what the region currently shows. */
  let loadedEmptyShown = false;

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
      const at = messages.findIndex((m) => m.id === newDividerAnchorId);
      if (at === -1) {
        // The anchor was deleted (the store keeps it as a tombstone): the line
        // moves to the first message after it, or waits when there is none.
        const anchorId = newDividerAnchorId;
        const tombstone = getChannelMessages(options.channelId).some(
          (m) => m.id === anchorId && m.deleted,
        );
        if (tombstone) {
          const nextAt = messages.findIndex((m) => m.id > anchorId);
          if (nextAt === -1) return -1;
          newDividerAnchorId = messages[nextAt]!.id;
          return nextAt;
        }
      }
      if (at !== -1 || linePointer === undefined) return at;
      // The anchor left the window (a jump): place the line again by pointer.
      newDividerAnchorId = null;
    }
    // The first loaded message above the pointer, latched like the count-based
    // one — except at the top of the window, where older history may still
    // arrive above it and move the true boundary.
    const byPointer = (): number => {
      const idx = messages.findIndex((m) => m.id > (linePointer ?? 0));
      if (idx > 0) newDividerAnchorId = messages[idx]!.id;
      return idx;
    };
    // An around-window centred on a jumped-to message is not the tail: counting
    // back from its end would mark an arbitrary row. Detachment is read here,
    // not at mount, because a cross-channel jump detaches after the mount.
    if (isWindowDetached(options.channelId)) {
      newDividerDeferred = false;
      // No divider will exist to open at, and a pending open left armed would
      // scroll the reader up to the line once the tail returns.
      openAtDividerPending = false;
      // A pointer places the line inside the around-window too (never scrolled to).
      return linePointer === undefined ? -1 : byPointer();
    }
    // A revisit renders the cached window while its tail is refetched.
    // Those rows predate what arrived while away, so counting back from their
    // end would mark messages already read; wait for the fetched tail.
    newDividerDeferred = unreadOnOpen > 0 && getHistoryLoadState(options.channelId) === "loading";
    if (newDividerDeferred) return -1;
    if (linePointer !== undefined) {
      // Only a channel that had unread when opened: with none, the first message
      // above the pointer is just the first live arrival.
      return unreadOnOpen > 0 ? byPointer() : -1;
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

  /** Render one virtual item — the single place the item kinds map to DOM. */
  function renderVirtualItem(item: VirtualItem): HTMLElement {
    if (item.kind === "divider") return renderDayDivider(item.timestamp);
    if (item.kind === "new-divider") return renderNewDivider();
    const owner = new Disposable();
    if (item.kind === "blocked-run") {
      const el = renderBlockedRun(item, () => toggleBlockedRun(item.firstId), owner.signal);
      rowOwners.set(el, owner);
      return el;
    }
    // The one editor node is re-hosted by every build of its row.
    const editor =
      edit !== null && edit.session !== null && edit.messageId === item.message.id
        ? edit.session.element
        : undefined;
    const el = renderMessage(
      item.message,
      item.isGrouped,
      replyParents,
      renderOptions,
      owner.signal,
      editor,
    );
    rowOwners.set(el, owner);
    return el;
  }

  /** Discard one rendered row: stop tracking its media and abort its listeners. */
  function releaseRow(el: HTMLElement): void {
    const editorEl = edit?.session?.element;
    if (editorEl !== undefined && el.contains(editorEl) && editHoldsFocus()) editRefocus = true;
    for (const img of el.querySelectorAll("img")) discardMedia(img);
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
    const cached = heightCache.get(itemKey(index));
    if (cached !== undefined) return cached;
    return estimateRow(index);
  }

  /** A message row's height key across lists; null for rows that are not a
   *  confirmed message. */
  function rememberKey(index: number): string | null {
    const item = virtualItems[index];
    if (item === undefined || item.kind !== "message" || item.message.id === 0) return null;
    return rowHeightKey(item.message.id, item.isGrouped, item.message.editedAt);
  }

  /** An unmeasured row: the height an earlier list of this channel drew it at,
   *  else the estimate. */
  function estimateRow(index: number): number {
    const key = estimateWidth === undefined ? null : rememberKey(index);
    const remembered = key === null ? undefined : rememberedRowHeight(key, estimateWidth!);
    return remembered ?? estimateItemHeight(virtualItems[index]!, estimateWidth);
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

  // Set by the reader's own send; held while the window is detached, until
  // the live tail lands and the next render scrolls to it. It lapses if the
  // tail never lands, so a later reattach cannot pull the reader down.
  let followOwnSendUntil = 0;
  const ownSends = (list: readonly Message[]): number =>
    list.filter(
      (m) =>
        m.id === 0 &&
        m.user.id === options.currentUserId &&
        (m.status === "pending" || m.status === "failed" || m.status === "uploading") &&
        !(m.correlationId?.startsWith("recovered:") ?? false),
    ).length;
  const followOwnSend = (): boolean =>
    performance.now() < followOwnSendUntil && !isWindowDetached(options.channelId);
  // Once attached, a newer page in flight can no longer land, so it does not
  // veto the reader's own send.
  const keepBottom = (): boolean => (isNearBottom() && !loadingNewer) || followOwnSend();

  /** The metrics handleScroll read this frame, for the scroll rAF's renderWindow
   *  to reuse. Dropped by any renderWindow or scrollToBottom, so it never
   *  outlives a pass or a write that could have moved the viewport. */
  let scrollSnapshot: ScrollMetrics | null = null;

  /** The one place the list moves the viewport: a write invalidates the frame's
   *  snapshot, so the rAF cannot render for the position from before it. */
  function setScrollTop(top: number): void {
    if (root === null) return;
    scrollSnapshot = null;
    root.scrollTop = top;
  }

  function isNearBottom(threshold = SCROLL_BOTTOM_THRESHOLD, m?: ScrollMetrics): boolean {
    if (root === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(root);
    return scrollHeight - scrollTop - clientHeight < threshold;
  }

  /** The true bottom (1 px tolerates fractional scrollTop on HiDPI), unlike the 100 px isNearBottom. */
  function isAtBottom(m?: ScrollMetrics): boolean {
    if (root === null) return true;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(root);
    return scrollHeight - scrollTop - clientHeight <= 1;
  }

  function scrollToBottom(): void {
    if (root === null) return;
    setScrollTop(root.scrollHeight);
  }

  /** Distance from the bottom at the last scroll event or resize pass: what the
   *  resize observer judges "at the bottom" by, since by the time it runs a
   *  grown row has already pushed the bottom further away. */
  let bottomGapBeforeResize = 0;

  function bottomGap(m?: ScrollMetrics): number {
    if (root === null) return 0;
    const { scrollTop, scrollHeight, clientHeight } = m ?? readMetrics(root);
    return scrollHeight - scrollTop - clientHeight;
  }

  /** What the pill shows now, so a scroll burst writes the DOM only on a change. */
  let btnShownKey = "";

  function updateScrollToBottomBtn(m?: ScrollMetrics): void {
    if (scrollToBottomBtn === null) return;
    const near = isNearBottom(SCROLL_BOTTOM_THRESHOLD, m);
    if (near) newBelowCount = 0;
    const key = `${near ? 1 : 0}:${newBelowCount}`;
    if (key === btnShownKey) return;
    btnShownKey = key;
    scrollToBottomBtn.classList.toggle("visible", !near);
    if (scrollToBottomCount === null) return;
    const shown = formatBadgeCount(newBelowCount);
    scrollToBottomCount.hidden = newBelowCount === 0;
    scrollToBottomCount.textContent = newBelowCount === 0 ? "" : shown;
    scrollToBottomBtn.setAttribute(
      "aria-label",
      newBelowCount === 0
        ? messagingText("scrollToBottom")
        : messagingText("scrollToBottomNew", { count: newBelowCount, shown }),
    );
  }

  /** The pill is the only signal that the bottom of the list is not "now". */
  function updateJumpToPresentPill(): void {
    if (jumpToPresentPill === null) return;
    jumpToPresentPill.classList.toggle("visible", isWindowDetached(options.channelId));
  }

  /** Move the view to the NEW divider once one exists. Does not force a row rebuild (R2). */
  function openAtDividerIfReady(): boolean {
    // Hidden, the scroller cannot move: the resize observer places it once shown.
    if (!openAtDividerPending || root === null || root.clientHeight === 0) return false;
    const idx = virtualItems.findIndex((item) => item.kind === "new-divider");
    if (idx === -1) return false;
    openAtDividerPending = false;
    // The rows between here and the divider are estimates until rendered, so
    // settle against their measured heights, as a jump does.
    for (let pass = 0; pass < 3; pass++) {
      if (!placeIndex(idx, -UNREAD_BAR_CLEARANCE)) break;
    }
    updateScrollToBottomBtn();
    return true;
  }

  /** The bar shows while the visit has unread it has not dismissed. */
  function updateUnreadBar(): void {
    if (unreadBar === null || unreadBarLabel === null) return;
    let text = "";
    // A detached window draws no NEW line, so the bar (which counts toward it)
    // stays hidden until the tail returns.
    if (!unreadBarDismissed && unreadOnOpen > 0 && !isWindowDetached(options.channelId)) {
      const shown = formatBadgeCount(openedUnread);
      if (unreadOnOpen === Infinity) {
        text = messagingText("unreadBar.capped", { shown });
      } else {
        // The divider latches to the first unread message; until it does (a
        // deferred revisit) there is no time to show.
        const anchor = allMessages.find((m) => m.id === newDividerAnchorId);
        if (anchor !== undefined) {
          text = messagingText("unreadBar.since", {
            count: openedUnread,
            shown,
            time: formatMessageTimestamp(anchor.timestamp),
          });
        }
      }
    }
    unreadBarLabel.textContent = text;
    unreadBar.hidden = text === "";
    // Announce when the count first appears, not on every refresh.
    if (unreadAnnouncer !== null) {
      if (text === "") unreadAnnouncer.textContent = "";
      else if (unreadAnnouncer.textContent === "") unreadAnnouncer.textContent = text;
    }
  }

  function dismissUnreadBar(): void {
    unreadBarDismissed = true;
    updateUnreadBar();
  }

  function markReadAndJumpToPresent(): void {
    if (root === null) return;
    dismissUnreadBar();
    // Just marked unread: Escape is the reader asking for it read, so mark at
    // latest (which also ends the hold). Otherwise what was seen. The gate
    // keeps a held or repeated Escape off the 5/s mark_read budget.
    if (readPointerEnabled() && isHeldUnread(options.channelId)) {
      markChannelRead(options.channelId);
    } else if (hasUnread(options.channelId) || readPointerEnabled()) {
      markChannelReadSeen(options.channelId);
    }
    if (isWindowDetached(options.channelId)) {
      options.onJumpToPresent?.();
      return;
    }
    scrollToBottom();
    updateScrollToBottomBtn();
  }

  function scrollPage(direction: 1 | -1): void {
    if (root === null) return;
    // About what the browser's own PageDown moves, keeping a line of context.
    setScrollTop(root.scrollTop + direction * Math.round(root.clientHeight * PAGE_SCROLL_FRACTION));
  }

  /** A messagesByChannel / historyLoadState change landed: refresh the bar and the open position. */
  function settleUnreadNav(): void {
    // Only while the reader is still at the bottom the mount left them at.
    if (openAtDividerPending && isNearBottom()) openAtDividerIfReady();
    updateUnreadBar();
    markReadIfSeen();
  }

  /**
   * The channel is read once the reader has seen its bottom with
   * the window focused. Fires on every scroll and on window focus; the
   * hasUnread gate keeps a plain scroll from spending the server's 5/s
   * mark_read budget, and the bottom of a detached window is not the present,
   * so that case is excluded too (isChannelAway, lib/read-state.ts).
   * The bottom-in-view check alone also covers focus returning while the reader
   * is scrolled up.
   */
  function markReadIfSeen(m?: ScrollMetrics): void {
    if (root === null) return;
    if (!isReadSurface(options.channelId, channelsStore.getState().activeChannelId)) return;
    if (!isAtBottom(m) || isChannelAway(options.channelId)) {
      bottomMarked = false;
      noteVisibleRowsSeen(m);
      return;
    }
    // The cached bottom of a revisit predates what arrived while away; keep
    // the bar until the refetched tail places the divider.
    if (newDividerDeferred) return;
    dismissUnreadBar();
    // With a read pointer the mark is what was seen, and what gates it is the
    // pointer (nothing is sent unless the newest seen id is above it); without
    // one, the local unread count gates it, as before.
    if (readPointerEnabled()) {
      if (!isChannelCovered()) noteMessageSeen(options.channelId, newestLoadedId());
      // Every append auto-scrolls and lands here: send on reaching the bottom
      // only. Arrivals watched at the bottom go by the throttled live path.
      if (bottomMarked) return;
      bottomMarked = true;
    } else if (!hasUnread(options.channelId)) return;
    markChannelReadSeen(options.channelId);
  }

  /**
   * A reader scrolling short of the bottom has seen the rows on screen: record
   * the newest confirmed one whose top is above the viewport's bottom, so
   * leaving sends `mark_read` up to it (the badge was cleared on open, and the
   * server must follow). Records only; nothing is sent here. Reads the height
   * tree, not the DOM, so a scroll event costs one lookup.
   */
  function noteVisibleRowsSeen(m?: ScrollMetrics): void {
    if (root === null || !readPointerEnabled() || isChannelCovered()) return;
    if (newDividerDeferred || virtualItems.length === 0) return;
    // The last pixel in view: a row starting exactly at the bottom edge is not.
    const { scrollTop, clientHeight } = m ?? readMetrics(root);
    const bottom = scrollTop + Math.max(clientHeight - 1, 0);
    for (let i = Math.min(offsetToIndex(bottom), virtualItems.length - 1); i >= 0; i--) {
      const item = virtualItems[i]!;
      if (item.kind === "blocked-run" && !item.expanded) {
        noteVisibleMessageSeen(options.channelId, item.lastId);
        return;
      }
      if (item.kind !== "message" || item.message.id <= 0) continue;
      noteVisibleMessageSeen(options.channelId, item.message.id);
      return;
    }
  }

  /** The newest confirmed message loaded here (pending rows have no id yet); 0 for none. */
  function newestLoadedId(): number {
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i]!.id > 0) return allMessages[i]!.id;
    }
    return 0;
  }

  /**
   * Mark Unread from `messageId` (the message menu, Alt+click): the server's
   * pointer and the NEW line both move to just before it. A no-op unless the
   * server keeps a read pointer.
   */
  function markUnreadFrom(messageId: number): void {
    const before = {
      linePointer,
      newDividerAnchorId,
      markedUnread,
      unreadBarDismissed,
      openedUnread,
      unreadOnOpen,
    };
    const pointer = markMessageUnread(options.channelId, messageId);
    if (pointer === null) return;
    unmarked = before;
    linePointer = pointer;
    newDividerAnchorId = messageId;
    markedUnread = true;
    unreadBarDismissed = false;
    refreshUnreadFromChannel(messageId);
    if (!patchRows()) renderAll();
  }

  /** What the list showed before the latest Mark Unread, to go back to if it fails. */
  let unmarked: {
    readonly linePointer: number | undefined;
    readonly newDividerAnchorId: number | null;
    readonly markedUnread: boolean;
    readonly unreadBarDismissed: boolean;
    readonly openedUnread: number;
    readonly unreadOnOpen: number;
  } | null = null;

  /**
   * The Mark Unread did not happen (refused, or never sent) and its pointer is
   * back: the NEW line and the unread bar go back to what they were. A
   * confirming `read_state` never comes here, so a mark that worked stays.
   */
  function revertMarkUnread(): void {
    if (unmarked === null) return;
    ({
      linePointer,
      newDividerAnchorId,
      markedUnread,
      unreadBarDismissed,
      openedUnread,
      unreadOnOpen,
    } = unmarked);
    unmarked = null;
    updateUnreadBar();
    if (!patchRows()) renderAll();
  }

  /**
   * After Mark Unread the top bar and the line count what is unread now: the
   * channel's count once the server has answered (`read_state`), until then the
   * loaded messages from the marked one on.
   */
  function refreshUnreadFromChannel(markedId: number): void {
    const known = channelsStore.getState().channels.get(options.channelId)?.unreadCount ?? 0;
    openedUnread = known > 0 ? known : allMessages.filter((m) => m.id >= markedId).length;
    unreadOnOpen = openedUnread >= UNREAD_COUNT_CAP ? Infinity : openedUnread;
    updateUnreadBar();
  }

  /**
   * A live message was appended while the reader had the live tail in view. The
   * dispatcher does not count it unread, so markReadIfSeen (gated on a local
   * unread count) never sends for it; tell the server it was seen, throttled
   * (lib/read-state.ts). Same away and deferred-divider checks as above, plus
   * the Settings overlay and content views, which cover a still-mounted list.
   */
  function markLiveArrivalSeen(): void {
    if (root === null) return;
    if (!isReadSurface(options.channelId, channelsStore.getState().activeChannelId)) return;
    if (isChannelAway(options.channelId) || isChannelCovered()) return;
    if (newDividerDeferred) return;
    noteMessageSeen(options.channelId, newestLoadedId(), true);
    noteLiveMessageSeen(options.channelId, disposable.signal);
  }

  // ---------------------------------------------------------------------------
  // Render visible window
  // ---------------------------------------------------------------------------

  /** Record the heights of the rendered rows, or only those whose item index
   *  lies in [from, to) (a slide measures just the rows that entered; every
   *  other row was measured when it entered or by the ResizeObserver pass). */
  function measureRendered(from: number = renderedStart, to: number = renderedEnd): void {
    if (contentContainer === null || renderedStart < 0) return;
    const children = contentContainer.children;
    const first = Math.max(0, from - renderedStart);
    const last = Math.min(children.length, to - renderedStart);

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
      const globalIdx = renderedStart + i;
      if (globalIdx < 0 || (tree !== null && globalIdx >= tree.size)) continue;
      const el = children[i] as HTMLElement;
      const style = getComputedStyle(el);
      const h = el.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      if (h > 0) {
        measurements.push({ key: itemKey(globalIdx), idx: globalIdx, h });
      }
    }

    // The width these rows were laid out at, read with the heights (layout is
    // already clean): the observer may not have reported a resize yet.
    const measuredWidth = root?.clientWidth ?? 0;

    // Pass 2 — pure writes: apply all cached heights to heightCache and the
    // Fenwick tree. No DOM reads here, so no additional reflow is triggered.
    for (const { key, idx, h } of measurements) {
      heightCache.set(key, h);
      const shared = measuredWidth > 0 ? rememberKey(idx) : null;
      if (shared !== null) rememberRowHeight(shared, measuredWidth, h);
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

  /** Put focus back on the captured control's replacement; false when it has none. */
  function restoreRowFocus(
    captured: { own: string | null; row: string | null; index: number } | null,
  ): boolean {
    if (captured === null || contentContainer === null) return false;
    let target: HTMLElement | null | undefined = null;
    if (captured.own !== null) {
      target = contentContainer.querySelector<HTMLElement>(`[data-testid="${captured.own}"]`);
    } else if (captured.row !== null && captured.index >= 0) {
      target = contentContainer
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
    for (const owner of rowOwners.values()) owner.destroy();
    rowOwners.clear();
  }

  // The last jumped-to message, re-centred from the resize callback while
  // content above it is still sizing.
  let jumpTarget: { readonly messageId: number; readonly until: number } | null = null;

  /** Index of the message a recent jump is still centring, or -1. */
  function activeJumpIndex(): number {
    if (jumpTarget === null || Date.now() >= jumpTarget.until) return -1;
    const { messageId } = jumpTarget;
    return virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
  }

  let renderWindowCount = 0;
  let renderWindowResetTimer = 0;
  // Set when the breaker below drops a rebuild. Like renderAllSuppressed, the
  // 2s reset replays renderWindow once, so a fast scrollbar drag that trips it
  // still ends with the rows for where it stopped. Once per burst, not
  // per dropped call, so the image-height oscillation it stops cannot restart.
  let renderWindowSuppressed = false;

  /** Where `el`'s top edge sits in the scroller, in px below the top of the
   *  view; the one measure of position the heights model cannot drift from. */
  function edgeOf(el: Element): number {
    return root === null ? 0 : el.getBoundingClientRect().top - root.getBoundingClientRect().top;
  }

  /** Scroll so `el`'s top edge is back at `edge` after rows above it were
   *  built, released or re-measured: a row that entered above the view
   *  measures differently from the estimate its spacer share was cut by, and
   *  a divider's collapsed margin never matches the summed one. */
  function holdRow(el: Element, edge: number): void {
    if (root === null) return;
    const delta = edgeOf(el) - edge;
    if (Math.abs(delta) >= 1) setScrollTop(root.scrollTop + delta);
  }

  /** Slide the rendered window to [start, end), which overlaps it: release the
   *  rows that left, render only the rows that entered, keep the rest. */
  function shiftWindow(
    start: number,
    end: number,
    view: Pick<ScrollMetrics, "scrollTop" | "clientHeight">,
  ): void {
    if (contentContainer === null) return;
    // Rows that stay were measured when they entered or by the ResizeObserver
    // pass, so only the rows that leave (here, before they are released: one
    // may have grown since the last pass) and the rows that enter (below) are
    // measured.
    const prevStart = renderedStart;
    const prevEnd = renderedEnd;
    measureRendered(prevStart, start);
    measureRendered(end, prevEnd);
    const rows = [...contentContainer.children] as HTMLElement[];
    // Rows entering above the view keep the first row that stays in place on
    // screen; rows leaving above it are measured, so their spacer share is exact.
    const kept = start < renderedStart ? rows[0] : undefined;
    const keptEdge = kept === undefined ? 0 : edgeOf(kept);
    // Only a row the reader could see is worth holding: a jump to the top
    // shows the rows above it instead, laid out as they really are.
    const hold = kept !== undefined && keptEdge < view.clientHeight && view.scrollTop > 0;
    for (let i = 0; i < rows.length; i++) {
      const globalIdx = renderedStart + i;
      if (globalIdx < start || globalIdx >= end) releaseRow(rows[i]!);
    }
    const head = document.createDocumentFragment();
    for (let i = start; i < renderedStart; i++) {
      head.appendChild(renderVirtualItem(virtualItems[i]!));
    }
    const tail = document.createDocumentFragment();
    for (let i = renderedEnd; i < end; i++) {
      tail.appendChild(renderVirtualItem(virtualItems[i]!));
    }
    contentContainer.insertBefore(head, contentContainer.firstChild);
    contentContainer.appendChild(tail);
    renderedStart = start;
    renderedEnd = end;
    measureRendered(start, prevStart);
    measureRendered(prevEnd, end);
    updateSpacers();
    if (hold && kept.isConnected) holdRow(kept, keptEdge);
    refocusEditor();
  }

  /** The row that held the focused editor is back: give the editor focus again,
   *  unless the reader has put it somewhere else meanwhile. */
  function refocusEditor(): void {
    const el = edit?.session?.element;
    if (!editRefocus || el === undefined || !el.isConnected) return;
    const active = document.activeElement;
    editRefocus = false;
    if (active !== null && active !== document.body) return;
    el.querySelector("textarea")?.focus({ preventScroll: true });
  }

  function renderWindow(m?: ScrollMetrics): void {
    if (root === null || contentContainer === null || topSpacer === null || bottomSpacer === null)
      return;

    scrollSnapshot = null;
    const { scrollTop, clientHeight } = m ?? readMetrics(root);
    lastViewportHeight = clientHeight;

    if (virtualItems.length === 0) {
      releaseTrackedMedia();
      beginRowRender();
      clearChildren(contentContainer);
      // With no rows, the region shows the fetch state: an in-region loading
      // placeholder, an inline error + Retry, or the welcome/empty state once
      // the channel is actually loaded and empty (UX spec §1/§2).
      const loadState = getHistoryLoadState(options.channelId);
      // Every loaded row was deleted but the server has older ones: not an
      // empty channel, so load the page before them instead of welcoming.
      const allDeleted =
        loadState === null &&
        getChannelMessages(options.channelId).length > 0 &&
        hasMoreMessages(options.channelId);
      // The page before them just failed to load: say so, with a retry,
      // instead of a placeholder that never ends.
      const olderFailed = allDeleted && !loadingOlder && performance.now() < olderRetryAt;
      if (olderFailed) {
        contentContainer.appendChild(
          renderLoadErrorState(() => {
            olderRetryAt = 0;
            renderWindow();
          }),
        );
      } else if (loadState === "loading" || allDeleted) {
        contentContainer.appendChild(renderLoadingState());
      } else if (loadState === "error") {
        contentContainer.appendChild(renderLoadErrorState(options.onRetryLoad));
      } else {
        contentContainer.appendChild(renderEmptyState(options.channelName, options.channelType));
      }
      loadedEmptyShown = loadState === null && !allDeleted;
      if (allDeleted && !loadingOlder && !olderFailed) fireOlderLoad();
      topSpacer.style.height = "0px";
      bottomSpacer.style.height = "0px";
      renderedStart = 0;
      renderedEnd = 0;
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
    const end = Math.min(virtualItems.length, lastVisible + below + 1);
    // A divider is drawn with the row under it: that row's top margin depends
    // on the divider being there, so a window starting between them would
    // measure the row differently from how it is laid out once both show.
    while (start > 0 && virtualItems[start - 1]!.kind !== "message") start--;

    // Rebuild the DOM when explicitly requested by renderAll (which sets
    // renderedStart to -1) or when the target range has left the rendered
    // window — scrolling past the overscan must materialize the rows the
    // spacers are standing in for. When the range is already fully rendered
    // this is a no-op, which (together with the rebuild rate limiter below)
    // prevents the height oscillation loop where images loading → height
    // change → range recalculation → DOM rebuild → images reload → repeat.
    const rangeAlreadyRendered = renderedStart >= 0 && start >= renderedStart && end <= renderedEnd;
    // A scroll that only slides the window keeps the rows still in range and
    // builds just the ones entering it. It is cheap and never reloads a kept
    // row's media, so it neither consumes the rebuild breaker below nor can
    // feed the height oscillation that breaker guards.
    if (
      !rangeAlreadyRendered &&
      renderedStart >= 0 &&
      start < renderedEnd &&
      end > renderedStart &&
      contentContainer.children.length === renderedEnd - renderedStart
    ) {
      shiftWindow(start, end, { scrollTop, clientHeight });
      return;
    }
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
      if (editHoldsFocus()) editRefocus = true;
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
    replyParents = getChannelMessages(options.channelId);
    allMessages = visibleMessages(replyParents);
    virtualItems = buildVirtualItems(
      allMessages,
      resolveNewDividerIndex(allMessages),
      blockedUsers(),
      shownBlocked,
    );

    seedTree();
  }

  /** Estimate again every row that has no measured height, leaving measured
   *  rows (and so the rendered window) as they are. */
  function reseedUnmeasured(): void {
    if (tree === null) return;
    for (let i = 0; i < virtualItems.length; i++) {
      if (!heightCache.has(itemKey(i))) tree.set(i, estimateRow(i));
    }
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
      if (i === undefined || i < renderedStart || i >= renderedEnd) return false;
    }
    let atHead = true;
    for (let i = renderedStart; i < renderedEnd; i++) {
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
    if (root === null || contentContainer === null || tree === null) return false;
    if (renderAllRunning || renderedStart < 0 || allMessages.length === 0) return false;
    const nextParents = getChannelMessages(options.channelId);
    const next = visibleMessages(nextParents);
    if (next.length === 0) return false;
    const prevItems = virtualItems;
    const nextItems = buildVirtualItems(
      next,
      resolveNewDividerIndex(next),
      blockedUsers(),
      shownBlocked,
    );
    const prevKeys = prevItems.map(keyOf);
    const nextKeys = nextItems.map(keyOf);
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
    for (let i = renderedStart; i < renderedEnd; i++) {
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
    if (renderedStart === 0 && !prepended) start = 0;
    if (renderedEnd === prevItems.length) end = nextItems.length;
    if (end - start > MAX_INCREMENTAL_WINDOW) return false;

    // A newer history page landing below the reader is not a live arrival:
    // the reader keeps their place instead of being carried to the new bottom.
    const atBottom = keepBottom();
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
    const anchorRow = prepended ? renderedRowAt(anchor) : undefined;
    const anchorEdge = anchorRow === undefined ? null : edgeOf(anchorRow);

    // A reply re-renders its quote when its parent left, arrived, or changed
    // what the quote draws (renderReplyRef reads the parent from replyParents);
    // a reaction or pin on the parent leaves the reply alone.
    const prevById = new Map(replyParents.map((m) => [m.id, m]));
    const nextById = new Map(nextParents.map((m) => [m.id, m]));
    const quoteChanged = (id: number | null): boolean => {
      if (id === null) return false;
      const a = prevById.get(id);
      const b = nextById.get(id);
      return a?.content !== b?.content || a?.deleted !== b?.deleted || a?.user !== b?.user;
    };

    const focused = captureRowFocus();
    const editHadFocus = editHoldsFocus();
    const prevStart = renderedStart;
    const prevEnd = renderedEnd;
    const shown = [...contentContainer.children] as HTMLElement[];
    // The row holding focus, so focus can move on if that row is removed.
    const focusedAt = shown.findIndex((el) => el.contains(document.activeElement));
    const focusedKey = focusedAt === -1 ? undefined : prevKeys[prevStart + focusedAt];
    const shownByKey = new Map(shown.map((el, i) => [prevKeys[renderedStart + i]!, el]));
    allMessages = next;
    replyParents = nextParents;
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
      if (!restoreRowFocus(focused) && focusedKey !== undefined && !nextIndex.has(focusedKey)) {
        // The focused row was removed (deleted): focus the next surviving row,
        // or the one before it, rather than dropping to <body>.
        focusSurvivingRow(prevKeys, nextIndex, rows, start, prevStart, prevEnd, focusedKey);
      }
    }

    if (atBottom) {
      scrollToBottom();
      if (prepended) renderWindow();
      updateScrollToBottomBtn();
    } else if (anchorKey === undefined) {
      if (prepended) renderWindow();
    } else {
      const anchorAt = nextIndex.get(anchorKey)!;
      setScrollTop(Math.max(0, offsetBefore(anchorAt) + anchorOffset));
      if (prepended) {
        // The page above is spacer only: draw the rows now in view, then
        // re-place the anchor against the heights they measured.
        renderWindow();
        for (let pass = 0; pass < 3; pass++) {
          if (!placeIndex(anchorAt, anchorOffset)) break;
        }
        const el = renderedRowAt(anchorAt);
        if (el !== undefined && anchorEdge !== null) holdRow(el, anchorEdge);
      }
    }
    dropGoneEdit(editHadFocus);
    // The rows changed under the reader without a scroll event: a newer page
    // landing below a reader near the bottom of a detached window leaves them
    // where they were, so the resize pass must not pull them down to it.
    bottomGapBeforeResize = bottomGap();
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

  function renderedRowAt(idx: number): Element | undefined {
    if (renderedStart < 0 || idx < renderedStart || idx >= renderedEnd) return undefined;
    return contentContainer?.children[idx - renderedStart];
  }

  function renderAll(hold?: { readonly key: string; readonly edge: number }): void {
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
    const editHadFocus = editHoldsFocus();
    try {
      log.debug("renderAll START", { count: renderAllCount });
      wasAtBottom = keepBottom();

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
      if (!wasAtBottom && root !== null && hold === undefined) {
        const anchorIdx = topMessageIndex();
        if (anchorIdx !== -1) {
          anchorMessageId = (virtualItems[anchorIdx] as VirtualItemMessage).message.id;
          anchorOffsetInItem = root.scrollTop - offsetBefore(anchorIdx);
          const el = renderedRowAt(anchorIdx);
          if (el !== undefined) anchorEdge = edgeOf(el);
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
        setScrollTop(Math.max(0, estTotal - root.clientHeight));
      } else if (hold !== undefined && root !== null) {
        const at = virtualItems.findIndex((item, i) => keyOf(item, i) === hold.key);
        if (at !== -1) {
          const estTotal = totalHeight();
          if (topSpacer !== null) topSpacer.style.height = "0px";
          if (bottomSpacer !== null) bottomSpacer.style.height = `${estTotal}px`;
          setScrollTop(Math.max(0, offsetBefore(at) - hold.edge));
        }
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
          setScrollTop(Math.max(0, offsetBefore(newIdx) + anchorOffsetInItem));
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
      } else if (hold !== undefined) {
        const at = virtualItems.findIndex((item, i) => keyOf(item, i) === hold.key);
        if (at !== -1) {
          for (let pass = 0; pass < 3; pass++) {
            if (!placeIndex(at, -hold.edge)) break;
          }
          const el = renderedRowAt(at);
          if (el !== undefined) holdRow(el, hold.edge);
        }
      } else if (anchorMessageId !== null) {
        // The anchor above was applied against estimates for the rows the
        // rebuild put above the reader (a prepended page); renderWindow has
        // now measured the ones it built, so re-place the row and re-window
        // until it stays put, as scrollToMessage settles.
        const idx = virtualItems.findIndex(
          (item) => item.kind === "message" && item.message.id === anchorMessageId,
        );
        if (idx !== -1) {
          for (let pass = 0; pass < 3; pass++) {
            if (!placeIndex(idx, anchorOffsetInItem)) break;
          }
          // Then by its real edge: the rebuilt row is on screen now.
          const el = renderedRowAt(idx);
          if (el !== undefined && anchorEdge !== null) holdRow(el, anchorEdge);
        }
      }
      dropGoneEdit(editHadFocus);
      bottomGapBeforeResize = bottomGap();
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
  // In-flight latch for the page below a detached window: rapid scrolling
  // fires one fetch, not one per scroll event. Also marks the store change
  // that lands while it is set as a history page, not a live arrival.
  let loadingNewer = false;
  let newerRetryAt = 0;
  /** Spinner row at the top of the history while an older page is in flight.
   *  Absolutely positioned in the scroller, so showing or hiding it never
   *  moves the rows (and never fires a scroll that could refetch). */
  let olderLoadingRow: HTMLDivElement | null = null;
  function setLoadingOlder(value: boolean): void {
    loadingOlder = value;
    if (!value) olderLoadingRow?.remove();
    else if (olderLoadingRow !== null) root?.appendChild(olderLoadingRow);
    updateOlderFailedRow();
  }
  /** "Couldn't load messages" + Retry over the top of the history after a failed
   *  older-page fetch. Overlays the region like the spinner, so no row moves. */
  let olderFailedRow: HTMLDivElement | null = null;
  function updateOlderFailedRow(): void {
    if (olderFailedRow === null) return;
    olderFailedRow.hidden = loadingOlder || !hasOlderLoadFailed(options.channelId);
  }
  /** An explicit Retry click: goes at once, past the automatic-retry cooldown. */
  function retryOlder(): void {
    if (loadingOlder) return;
    olderRetryAt = 0;
    fireOlderLoad();
    // The row hides while the page loads: keep keyboard focus in the list.
    root?.focus({ preventScroll: true });
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

  /** The newest delivered row's id (optimistic rows carry id 0). */
  function lastSentId(): number {
    return getChannelMessages(options.channelId).findLast((m) => m.id > 0)?.id ?? 0;
  }

  function fireOlderLoad(): void {
    setLoadingOlder(true);
    const oldestAtFire = getChannelMessages(options.channelId)[0]?.id;
    // A failed fetch never changes the message count, so the subscriber
    // above (which only reacts to a count change) would leave loadingOlder
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
      // With every loaded row deleted there is nothing else to redraw the
      // region: show the outcome (the next page, or the failure and Retry).
      if (virtualItems.length === 0 && !disposable.signal.aborted) renderWindow();
    });
  }

  let scrollRafId = 0;
  let resizeRafId = 0;
  /** The scroll viewport's height at the last resize pass: the window's overscan
   *  is a distance, so it must be recomputed when the viewport grows or shrinks. */
  let lastViewportHeight = 0;
  let resizeObserver: ResizeObserver | null = null;
  function handleScroll(): void {
    if (root === null) return;

    // Load older messages well before the top; the floor keeps the
    // trigger working when the viewport has no height yet.
    // The frame's only layout read: everything below, and the rAF's renderWindow,
    // works from this snapshot, so the DOM writes in between cannot force a
    // second layout.
    const m = readMetrics(root);
    scrollSnapshot = m;
    if (m.clientHeight > 0) bottomGapBeforeResize = bottomGap(m);
    const nearTop =
      m.scrollTop < Math.max(SCROLL_TOP_THRESHOLD, m.clientHeight * SCROLL_TOP_VIEWPORTS);
    if (!nearTop) olderRetryAt = 0;
    if (
      nearTop &&
      !loadingOlder &&
      performance.now() >= olderRetryAt &&
      hasMoreMessages(options.channelId)
    ) {
      fireOlderLoad();
    }

    // A detached window pages DOWN toward the present as the reader nears its
    // bottom; the page that reaches the newest message reattaches it.
    const nearBottomZone = isNearBottom(
      Math.max(SCROLL_BOTTOM_THRESHOLD, m.clientHeight * SCROLL_BOTTOM_VIEWPORTS),
      m,
    );
    if (!nearBottomZone) newerRetryAt = 0;
    if (
      nearBottomZone &&
      options.onScrollBottom !== undefined &&
      !loadingNewer &&
      performance.now() >= newerRetryAt &&
      isWindowDetached(options.channelId)
    ) {
      loadingNewer = true;
      const newestAtFire = lastSentId();
      void Promise.resolve(options.onScrollBottom()).finally(() => {
        loadingNewer = false;
        // Nothing landed (failed, or the window was replaced): hold off so
        // continued scrolling does not send one failing request after another.
        if (lastSentId() === newestAtFire)
          newerRetryAt = performance.now() + OLDER_RETRY_COOLDOWN_MS;
      });
    }

    // Update floating scroll-to-bottom button visibility
    updateScrollToBottomBtn(m);
    // Before markReadIfSeen, which asks isChannelAway. The 100 px auto-scroll
    // threshold on purpose: inside it a new message is scrolled into view.
    setLiveTailInView(options.channelId, isNearBottom(SCROLL_BOTTOM_THRESHOLD, m));
    // Reaching the bottom counts as seeing it.
    markReadIfSeen(m);

    // Debounce virtual window updates to animation frames
    if (scrollRafId === 0) {
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = 0;
        renderWindow(scrollSnapshot ?? undefined);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Profile popup (author name, avatar, @mention chip)
  // ---------------------------------------------------------------------------

  /** Closes the popup this list opened; null until one has been. */
  let closeProfilePopup: (() => void) | null = null;

  /** The author name, avatar or user @mention chip `target` is inside, if any.
   *  @everyone/@here chips carry no `data-user-id`, so they never match. */
  function profileControlOf(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null;
    const control = target.closest<HTMLElement>(
      ".msg-author[data-user-id], .msg-avatar[data-user-id], .mention[data-user-id]",
    );
    if (control === null || contentContainer === null || !contentContainer.contains(control)) {
      return null;
    }
    return control;
  }

  function openProfileFrom(target: EventTarget | null, anchorX: number, anchorY: number): void {
    const control = profileControlOf(target);
    if (control === null) return;
    const userId = Number(control.dataset["userId"]);
    if (!Number.isInteger(userId) || userId <= 0) return;
    closeProfilePopup = openUserProfilePopup({
      userId,
      anchorX,
      anchorY,
      signal: disposable.signal,
      fallbackFocus: () => (control.isConnected ? control : null),
    });
  }

  // ---------------------------------------------------------------------------
  // Mount / Destroy
  // ---------------------------------------------------------------------------

  function mount(parentContainer: Element): void {
    region = createElement("div", { class: "messages-region" });
    // Focusable by script only (-1): the older-history Retry hands focus here.
    root = createElement("div", { class: "messages-container", tabindex: "-1" });

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

    olderFailedRow = createElement("div", {
      class: "messages-older-failed",
      role: "alert",
      "data-testid": "messages-older-failed",
    });
    olderFailedRow.appendChild(
      createElement("span", { class: "messages-load-error-text" }, messagingText("loadFailed")),
    );
    const olderRetryBtn = createElement(
      "button",
      { class: "messages-retry-btn", type: "button", "data-testid": "messages-older-retry" },
      messagingText("retry"),
    );
    olderRetryBtn.addEventListener("click", retryOlder, { signal: disposable.signal });
    olderFailedRow.appendChild(olderRetryBtn);
    updateOlderFailedRow();

    scrollToBottomBtn = createElement("button", {
      class: "scroll-to-bottom-btn",
      "aria-label": messagingText("scrollToBottom"),
    });
    btnShownKey = "";
    scrollToBottomBtn.append("↓");
    scrollToBottomCount = createElement("span", {
      class: "scroll-to-bottom-count",
      "data-testid": "scroll-to-bottom-count",
      hidden: "",
    });
    scrollToBottomBtn.appendChild(scrollToBottomCount);
    scrollToBottomBtn.addEventListener(
      "click",
      () => {
        scrollToBottom();
        updateScrollToBottomBtn();
      },
      { signal: disposable.signal },
    );

    const unreadBarParts = renderUnreadBar(() => {
      markChannelRead(options.channelId);
      dismissUnreadBar();
    }, disposable.signal);
    unreadBar = unreadBarParts.bar;
    unreadBarLabel = unreadBarParts.label;
    unreadAnnouncer = unreadBarParts.announcer;

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
    region.appendChild(olderFailedRow);
    region.appendChild(scrollToBottomBtn);
    region.appendChild(jumpToPresentPill);
    region.appendChild(unreadBar);
    region.appendChild(unreadAnnouncer);

    root.addEventListener("scroll", handleScroll, {
      signal: disposable.signal,
      passive: true,
    });

    // One delegated pair of listeners opens a user's profile from an author
    // name, an avatar or an @mention chip, so no row carries its own handler
    // (rows are rebuilt by virtual scrolling). Owned by disposable.signal.
    contentContainer.addEventListener(
      "click",
      (e) => {
        const control = profileControlOf(e.target);
        if (control === null) return;
        // A mention can be the label of a masked link ([@name](https://...)),
        // which would otherwise also navigate: the anchor's default action, and
        // main.ts's bubbling document listener that hands target=_blank links
        // to the system browser. Handle the click here and stop it, but only
        // inside an anchor so other document-level dismissals still see it.
        e.preventDefault();
        if (control.closest("a") !== null) e.stopPropagation();
        openProfileFrom(control, e.clientX, e.clientY);
      },
      { signal: disposable.signal },
    );
    contentContainer.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const control = profileControlOf(e.target);
        if (control === null) return;
        e.preventDefault();
        const rect = control.getBoundingClientRect();
        openProfileFrom(control, rect.left, rect.bottom);
      },
      { signal: disposable.signal },
    );
    disposable.signal.addEventListener("abort", () => closeProfilePopup?.(), { once: true });

    // One delegated listener opens the message menu, by right-click and by the
    // Menu key / Shift+F10 (which dispatch `contextmenu` to the focused control
    // with no pointer position). The lazy module decides whether the target
    // offers a menu (an image's own listener stops the event first; a text
    // field keeps the webview's own menu), and main.ts already suppresses the
    // webview's menu everywhere else, so nothing is prevented here.
    contentContainer.addEventListener(
      "contextmenu",
      (e) => {
        const { clientX: x, clientY: y, target } = e;
        withMessageMenu((m) =>
          m.openMessageMenuAt({
            opts: options,
            x,
            y,
            target,
            signal: disposable.signal,
            markUnread: markUnreadFrom,
          }),
        );
      },
      { signal: disposable.signal },
    );
    // The hover bar's "..." button: one delegated listener, so the menu is
    // owned by the list's signal and survives its row being patched or rebuilt.
    // A click on "..." while its menu is open closes it (the outside mousedown
    // already has), so the open state is noted at pointerdown, before that.
    let moreWasOpen = false;
    contentContainer.addEventListener(
      "pointerdown",
      (e) => {
        moreWasOpen = moreButtonOf(e.target)?.getAttribute("aria-expanded") === "true";
      },
      { signal: disposable.signal },
    );
    contentContainer.addEventListener(
      "click",
      (e) => {
        // Reset on every click, so a press on More released elsewhere cannot
        // leave the flag set; a keyboard click (detail 0) had no pointerdown.
        const skip = moreWasOpen && e.detail > 0;
        moreWasOpen = false;
        const button = moreButtonOf(e.target);
        if (button === null || skip) return;
        const testId = button.dataset["testid"] ?? "";
        withMessageMenu((m) => {
          // The first open waits for the menu module; a patch or scroll in that
          // time replaces the button, so anchor on the live one, or open nothing.
          const live = button.isConnected
            ? button
            : (contentContainer?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null);
          if (live === null) return;
          m.openMessageMenuFromButton({
            opts: options,
            button: live,
            signal: disposable.signal,
            markUnread: markUnreadFrom,
          });
        });
      },
      { signal: disposable.signal },
    );
    // Shift pressed before the pointer arrived still reveals Pin and Delete.
    contentContainer.addEventListener(
      "mouseover",
      (e) => {
        root?.classList.toggle("shift-held", e.shiftKey);
      },
      { signal: disposable.signal },
    );
    // Alt+click on a message row marks it unread (the lazy module decides which
    // targets count: not a link, button, image or text field).
    contentContainer.addEventListener(
      "click",
      (e) => {
        if (!e.altKey || !readPointerEnabled()) return;
        const { target } = e;
        withMessageMenu((m) =>
          m.markUnreadAt({ opts: options, target, markUnread: markUnreadFrom }),
        );
      },
      { signal: disposable.signal },
    );

    // Focus returning with the bottom already in view counts as seeing it.
    // Owned by disposable.signal so destroy() releases it.
    window.addEventListener("focus", () => markReadIfSeen(), { signal: disposable.signal });

    // Shift reveals the hover bar's Pin and Delete: one pair of
    // window listeners toggles a class on the list root, and CSS shows the
    // extra buttons. A lost keyup (focus left the window, the tab was hidden)
    // would leave them out, so both of those reset it. Owned by disposable.signal.
    const setShiftHeld = (held: boolean): void => {
      root?.classList.toggle("shift-held", held);
    };
    const trackShift = (e: KeyboardEvent): void => {
      // Releasing Shift hides the Shift-only buttons: if one holds focus, hand
      // it to the row's "..." first so it does not drop to <body>.
      if (e.type === "keyup" && !e.shiftKey) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.classList.contains("msg-shift-only")) {
          active
            .closest(".msg-actions-bar")
            ?.querySelector<HTMLElement>("[data-testid^='msg-more-']")
            ?.focus();
        }
      }
      setShiftHeld(e.shiftKey);
    };
    window.addEventListener("keydown", trackShift, { signal: disposable.signal });
    window.addEventListener("keyup", trackShift, { signal: disposable.signal });
    window.addEventListener("blur", () => setShiftHeld(false), { signal: disposable.signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) setShiftHeld(false);
      },
      { signal: disposable.signal },
    );

    // Watch for height changes in rendered items (images loading, embeds expanding).
    // A plain re-measure runs inside the observer callback, which comes after
    // layout and before paint: deferring it to the next frame painted one frame
    // with the rows below a grown image or card shifted, then snapped them back.
    // A pass that may build rows (a resized viewport, a jump settling, the NEW
    // divider still to place) resizes the observed content itself, so it waits
    // for the next frame instead of looping the observer.
    const resizePass = (): void => {
      if (root === null || contentContainer === null) return;
      // The text estimates wrap at the list's width: when it changes, the
      // rows nothing has measured yet are estimated again (below).
      const width = root.clientWidth;
      // A list mounted hidden learns its width here, even at the default one,
      // so the rows an earlier visit measured seed it.
      const widthChanged = width > 0 && width !== estimateWidth;
      if (widthChanged) estimateWidth = width;

      // A viewport that grew (pane enlarged, window maximized) needs more
      // rows than the window holds, with no scroll event to say so.
      const viewportHeight = root.clientHeight;
      if (viewportHeight !== lastViewportHeight) renderWindow();

      const jumpIdx = activeJumpIndex();
      if (jumpIdx !== -1) {
        if (widthChanged) reseedUnmeasured();
        measureRendered();
        updateSpacers();
        centreOnIndex(jumpIdx);
        return;
      }

      // Where the reader was before the content changed size: a row near the
      // bottom that grew past the threshold has already moved the bottom away
      // by the time this runs, which must not unpin a reader who was at it.
      const atBottom = isNearBottom() || bottomGapBeforeResize < SCROLL_BOTTOM_THRESHOLD;

      // Capture anchor: the first item that starts in view, and its offset
      // from the viewport top. Not the item straddling the top edge: growth
      // inside it (an image box settling below its header) would then move
      // every row the reader is looking at.
      const { scrollTop, clientHeight } = readMetrics(root);
      let anchorIdx = offsetToIndex(scrollTop);
      if (
        offsetBefore(anchorIdx) < scrollTop &&
        anchorIdx + 1 < renderedEnd &&
        offsetBefore(anchorIdx + 1) < scrollTop + clientHeight
      ) {
        anchorIdx++;
      }
      const anchorOffset = scrollTop - offsetBefore(anchorIdx);

      // The anchor above was read against the old estimates; the restore
      // below reads the new ones, so the reading position holds.
      if (widthChanged) reseedUnmeasured();

      // Re-measure rendered elements
      measureRendered();

      // Update spacer heights with new measurements
      updateSpacers();

      // Restore scroll position using anchor
      if (atBottom) {
        // A list mounted while hidden still owes the reader its NEW divider.
        if (!openAtDividerIfReady()) scrollToBottom();
      } else {
        setScrollTop(offsetBefore(anchorIdx) + anchorOffset);
      }
      bottomGapBeforeResize = bottomGap();
      keepEditorCaretInView();
    };
    resizeObserver = new ResizeObserver(() => {
      if (root === null || contentContainer === null) return;
      // Hidden (the call grid has the chat column, display: none): nothing is
      // laid out, so there is nothing to measure, and the position from before
      // it was hidden is what showing it again restores.
      if (root.clientHeight === 0) return;
      const buildsRows =
        root.clientHeight !== lastViewportHeight ||
        activeJumpIndex() !== -1 ||
        openAtDividerPending;
      if (!buildsRows) {
        if (resizeRafId === 0) resizePass();
        return;
      }
      if (resizeRafId !== 0) return;
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = 0;
        if (root !== null && root.clientHeight > 0) resizePass();
      });
    });
    resizeObserver.observe(contentContainer);
    resizeObserver.observe(root);

    parentContainer.appendChild(region);
    // Estimate at the real width from the first render, so rows an earlier
    // visit measured seed it rather than a reseed after the observer fires.
    if (root.clientWidth > 0) estimateWidth = root.clientWidth;

    openAtDividerPending = unreadOnOpen > 0;
    renderAll();
    // Fetch the inline editor chunk once the list is up, so ArrowUp opens at once.
    setOwnedTimeout(disposable.signal, preloadInlineEdit, 0);
    updateJumpToPresentPill();
    const openedAtDivider = openAtDividerIfReady();
    updateUnreadBar();
    // A deferred divider still moves the view later, so only the bottom
    // scrolls are skipped when the open already landed on it.
    if (!openedAtDivider) scrollToBottom();
    setLiveTailInView(options.channelId, isNearBottom());
    const initialScrollRaf = requestAnimationFrame(() => {
      if (!openedAtDivider) scrollToBottom();
    });
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
      onMarkUnreadFailed((channelId) => {
        if (channelId === options.channelId) revertMarkUnread();
      }),
    );
    unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(options.channelId)?.unreadCount,
        () => {
          if (markedUnread && newDividerAnchorId !== null) {
            refreshUnreadFromChannel(newDividerAnchorId);
          }
        },
      ),
    );
    unsubscribers.push(
      messagesStore.subscribeSelector(
        // Scoped to the mounted channel so updates to OTHER channels (their
        // array references are unchanged) never trigger a re-render here.
        (s) => s.messagesByChannel.get(options.channelId),
        () => {
          // Optimistic rows (id 0) sit at the tail; live rows land before them.
          const prevLast = allMessages.findLast((m) => m.id > 0)?.id ?? 0;
          // The loaded-and-empty welcome state was on screen, so a first row
          // is a live arrival and not the first page landing.
          const firstLive = prevLast === 0 && loadedEmptyShown;
          if (ownSends(getChannelMessages(options.channelId)) > ownSends(allMessages)) {
            followOwnSendUntil = performance.now() + FOLLOW_OWN_SEND_MS;
          }
          const wasBottom = isNearBottom() || followOwnSend();
          if (!patchRows()) {
            renderAll();
          }
          if (followOwnSend()) followOwnSendUntil = 0;
          // Only an append counts: a window swap drops the previous last row.
          const appended =
            firstLive || (prevLast > 0 && allMessages.some((m) => m.id === prevLast));
          if (!wasBottom && appended && !loadingNewer) {
            // Older ids (a prepend) and the reader's own rows never count.
            for (const m of allMessages) {
              if (m.id > prevLast && m.user.id !== options.currentUserId) newBelowCount++;
            }
          }
          // The page kept the reader in place: the live-tail flag now describes
          // that spot, not the one before the page landed.
          if (loadingNewer) setLiveTailInView(options.channelId, isNearBottom());
          updateScrollToBottomBtn();
          settleUnreadNav();
          if (wasBottom && appended && !loadingNewer && allMessages.some((m) => m.id > prevLast)) {
            markLiveArrivalSeen();
          }
        },
      ),
    );

    // Re-render the (empty) region when the first-page fetch transitions
    // between loading / error / idle. Shown rows are left alone: a revisit's
    // refetch finishing must not rebuild them, and any change the
    // fetch made reaches the messagesByChannel subscriber above. A NEW divider
    // still waiting for that fetch is patched in on its own (R2).
    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.historyLoadState.get(options.channelId),
        () => {
          if (virtualItems.length === 0 || (newDividerDeferred && !patchRows())) renderAll();
          settleUnreadNav();
        },
      ),
    );

    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.olderLoadFailed?.has(options.channelId) ?? false,
        () => updateOlderFailedRow(),
      ),
    );

    // Show/hide the pill as the window detaches from (and reattaches to) the
    // live tail. No re-render — only the pill's visibility changes.
    unsubscribers.push(
      messagesStore.subscribeSelector(
        (s) => s.detachedChannels.has(options.channelId),
        () => {
          updateJumpToPresentPill();
          updateUnreadBar();
          // A tail reload that changed no rows reattaches without a messages
          // update, so the reader's pending own send follows here instead.
          if (followOwnSend()) {
            followOwnSendUntil = 0;
            scrollToBottom();
            updateScrollToBottomBtn();
          }
        },
      ),
    );

    // A membership, role or profile (rename/avatar) change repaints only the
    // author identity of the rendered rows that changed, not the whole list.
    // The store bumps roleRevision on every such mutation, so
    // selecting the counter avoids touching a role map per presence update.
    // The signed-in user's own role change can also change their per-row
    // affordances (pin/delete), so that case — and only it — falls back to a
    // rebuild.
    lastCanManageMessages = canManageMessages();
    // A block or an unblock folds or unfolds the author's rows in place.
    let prevBlocked = blockedUsers();
    unsubscribers.push(
      blocksStore.subscribeSelector(
        (s) => [...s.blockedByMe].toSorted((x, y) => x - y).join(","),
        () => {
          const now = blockedUsers();
          // A run of someone blocked again starts folded, whatever was shown before.
          for (const m of allMessages) {
            if (now.has(m.user.id) && !prevBlocked.has(m.user.id)) shownBlocked.delete(m.id);
          }
          prevBlocked = now;
          renderAll();
        },
      ),
    );
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

    // A role rename, recolour or deletion changes how role pills read.
    unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => s.roles,
        () => refreshAuthorRows(),
      ),
    );

    // The server's per-channel verdicts change on a role or override edit.
    // Delete and pin are built into each row, so a change there rebuilds; react
    // only flips the lock on the rendered controls.
    unsubscribers.push(
      channelsStore.subscribeSelector(
        (s) => {
          const ch = s.channels.get(authorityChannelId(options.channelId));
          return `${String(ch?.canDeleteOthers)}|${String(ch?.canPin)}`;
        },
        () => renderAll(),
      ),
      channelsStore.subscribeSelector(
        (s) => s.channels.get(authorityChannelId(options.channelId))?.canReact,
        () => {
          if (contentContainer !== null) refreshReactionLocks(contentContainer, options.channelId);
        },
      ),
    );

    // A timeout starting or ending toggles the reaction controls' lock in place;
    // no row is rebuilt, so video, spoilers and focus survive.
    unsubscribers.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
        () => {
          if (contentContainer !== null) refreshReactionLocks(contentContainer, options.channelId);
        },
      ),
    );

    // A thread's count, name or archive state changes far more often than its
    // starter row is rebuilt: repaint the chips on screen in place.
    const repaintThreadChips = (): void => {
      if (contentContainer === null) return;
      refreshThreadChips(contentContainer, {
        messages: getChannelMessages(options.channelId),
        onOpen: options.onOpenThread,
        signal: disposable.signal,
      });
    };
    unsubscribers.push(
      threadsStore.subscribeSelector((s) => s.byId, repaintThreadChips),
      threadsStore.subscribeSelector((s) => s.byStarter, repaintThreadChips),
      threadsStore.subscribeSelector((s) => s.deleted, repaintThreadChips),
    );

    // Delete and reactions are disabled while the socket is down; flip
    // the gates on the rendered controls in place, without a rebuild.
    unsubscribers.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => {
          if (contentContainer === null) return;
          refreshConnectionControls(contentContainer);
          refreshReactionLocks(contentContainer, options.channelId);
        },
      ),
    );

    // "Today at …" becomes "Yesterday at …" when the local day turns, so the
    // rendered rows' relative times are relabelled in place once a day; rows
    // outside the window get fresh text when renderWindow builds them. Owned
    // by disposable.signal: destroy() releases the pending timer.
    atEachMidnight(disposable.signal, relabelRenderedTimes);

    // A relative <t:…:R> timestamp ("in 5 minutes") drifts while the channel
    // sits open, so the rendered ones are rewritten once a minute.
    const relabelRelative = (): void => {
      setOwnedTimeout(
        disposable.signal,
        () => {
          if (contentContainer?.querySelector('time.md-timestamp[data-style="R"]')) {
            relabelInlineTimestamps(contentContainer);
          }
          relabelRelative();
        },
        RELATIVE_TIMESTAMP_REFRESH_MS,
      );
    };
    relabelRelative();

    // Switching the 12h/24h clock preference relabels the rendered rows in
    // place, the same way midnight does. Owned by disposable.signal, so the
    // listener dies with the component.
    onPrefChange(["timeFormat"], relabelRenderedTimes, disposable.signal);
  }

  /**
   * Repaint author identity on the rendered rows whose author changed after a
   * members-store update, without rebuilding them. A row stores the
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
      // — without re-parsing or rebuilding them. A system row draws
      // its mentions with no server info, so it resyncs the same way.
      if (el.classList.contains("message")) {
        const mentionInfo = {
          mentions: msg.mentions,
          mentionsEveryone: msg.mentionsEveryone,
          mentionRoles: msg.mentionRoles,
        };
        resyncMentions(el, mentionInfo);
        el.classList.toggle(
          "mentioned",
          !msg.deleted && highlightsCurrentUser(msg.content, mentionInfo),
        );
      } else {
        resyncMentions(el);
      }
      const roleColor = userRoleColorVar(msg.user.id);
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
          createAvatarElement(author, {
            className: "msg-avatar",
            background: pickAvatarColor(author.username),
            attrs: { "data-user-id": String(msg.user.id) },
          }),
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
      const parent = replyParents.find((m) => m.id === replyTo);
      if (parent === undefined || parent.deleted) continue;
      if (bar.classList.contains("msg-reply-ref--blocked")) continue;
      const roleColor = userRoleColorVar(parent.user.id);
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
          createAvatarElement(author, {
            className: "rr-avatar",
            background: pickAvatarColor(author.username),
          }),
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
      for (const el of children[i]!.querySelectorAll(".msg-time, .sm-time")) {
        el.textContent = text;
      }
      // The gutter and compact times are the short clock form, with no day word.
      const clock = formatClockTime(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll(".msg-hover-time, .msg-compact-time")) {
        el.textContent = clock;
      }
      const title = fullDateTimeTitle(item.message.timestamp);
      for (const el of children[i]!.querySelectorAll<HTMLElement>(
        ".msg-time, .msg-hover-time, .msg-compact-time",
      )) {
        el.title = title;
      }
      const edited = children[i]!.querySelector<HTMLElement>(".msg-edited");
      if (edited !== null && item.message.editedAt !== null) {
        edited.title = fullDateTimeTitle(item.message.editedAt);
      }
      relabelInlineTimestamps(children[i]!);
    }
  }

  function destroy(): void {
    if (resizeObserver !== null) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    disposable.destroy();
    // A channel switch discards an open edit, as it always has.
    edit?.session?.destroy();
    edit = null;
    editGen++;
    setLiveTailInView(options.channelId, true);
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
    btnShownKey = "";
    scrollSnapshot = null;
    unreadBar = null;
    unreadBarLabel = null;
    unreadAnnouncer = null;
    scrollToBottomCount = null;
    newBelowCount = 0;
    jumpToPresentPill = null;
    olderLoadingRow = null;
    olderFailedRow = null;
  }

  /** Scroll so row `idx` sits `offset` px below the top of the view and
   *  render there; false when it already does. Each pass can build and
   *  measure rows above the target, moving it, so callers settle in a few. */
  function placeIndex(idx: number, offset: number): boolean {
    if (root === null) return false;
    const target = Math.max(0, offsetBefore(idx) + offset);
    if (Math.abs(target - root.scrollTop) < 1) return false;
    setScrollTop(target);
    renderWindow();
    return true;
  }

  /** Scroll so row `idx` is centred; false when it was already centred. */
  function centreOnIndex(idx: number): boolean {
    if (root === null) return false;
    return placeIndex(idx, -(root.clientHeight - getItemHeight(idx)) / 2);
  }

  function scrollToMessage(messageId: number): boolean {
    if (root === null) return false;
    const idx = virtualItems.findIndex(
      (item) => item.kind === "message" && item.message.id === messageId,
    );
    if (idx === -1) {
      if (!expandRunOf(messageId)) return false;
      rebuildItems();
      const at = virtualItems.findIndex(
        (item) => item.kind === "message" && item.message.id === messageId,
      );
      if (at !== -1 && revealIndex(at, true)) return true;
      renderAll();
      return false;
    }
    return revealIndex(idx, true);
  }

  /** Message ids of the blocked run spanning `firstId`..`lastId`. */
  function runIds(firstId: number, lastId: number): number[] {
    return allMessages.filter((m) => m.id >= firstId && m.id <= lastId).map((m) => m.id);
  }

  /** Open the collapsed run `messageId` sits in; false when it is in none. */
  function expandRunOf(messageId: number): boolean {
    const run = virtualItems.find(
      (item) =>
        item.kind === "blocked-run" &&
        !item.expanded &&
        item.firstId <= messageId &&
        messageId <= item.lastId,
    );
    if (run?.kind !== "blocked-run") return false;
    const members = runIds(run.firstId, run.lastId);
    if (!members.includes(messageId)) return false;
    for (const id of members) shownBlocked.add(id);
    return true;
  }

  /** Show or Hide the run headed by `firstId`, read from the current items (the
   *  row a click came from may be older than the run), holding its header in place. */
  function toggleBlockedRun(firstId: number): void {
    const key = `blk-${firstId}`;
    const at = virtualItems.findIndex((item, i) => keyOf(item, i) === key);
    const run = virtualItems[at];
    if (run?.kind !== "blocked-run") return;
    for (const id of runIds(run.firstId, run.lastId)) {
      if (run.expanded) shownBlocked.delete(id);
      else shownBlocked.add(id);
    }
    const el = renderedRowAt(at);
    renderAll(el === undefined ? undefined : { key, edge: edgeOf(el) });
  }

  /** Centre row `idx` in the view, rendering it; with `flash`, highlight it too. */
  function revealIndex(idx: number, flash: boolean, recentre = true): boolean {
    if (root === null) return false;
    const item = virtualItems[idx];
    if (item?.kind !== "message") return false;
    const messageId = item.message.id;
    setScrollTop(offsetBefore(idx));
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

    // Rendering measured the target (and its neighbours), so the top-aligned
    // offset above was built from estimates. Centre it with the real height.
    // Each move can render and measure new rows above the target, shifting
    // its offset again, so settle for a few passes (usually one or two).
    for (let pass = 0; pass < 3; pass++) {
      if (!centreOnIndex(idx)) break;
    }
    // Late-sizing content (previews, images) above the target keeps it
    // centred until the highlight flash ends.
    // The editor is not a jump: resizes must not pull it back to the centre.
    if (recentre) jumpTarget = { messageId, until: Date.now() + JUMP_RECENTRE_MS };

    // Briefly highlight the target message element
    if (flash && contentContainer !== null) {
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

  // ---------------------------------------------------------------------------
  // Inline edit
  // ---------------------------------------------------------------------------

  /** True while the open editor's textarea (or its links) holds focus. */
  function editHoldsFocus(): boolean {
    const el = edit?.session?.element;
    return el !== undefined && el.contains(document.activeElement);
  }

  /**
   * Draw message `id`'s row again in place and release the old one. Used when
   * editing starts or stops: the message object did not change, so patchRows
   * would keep the row. A row outside the rendered window is left to the next
   * build, which reads `edit`.
   */
  function replaceRenderedRow(id: number): void {
    if (contentContainer === null) return;
    const idx = virtualItems.findIndex((it) => it.kind === "message" && it.message.id === id);
    const old = idx === -1 ? undefined : renderedRowAt(idx);
    if (old === undefined || !(old instanceof HTMLElement)) return;
    const edge = edgeOf(old);
    const fresh = renderVirtualItem(virtualItems[idx]!);
    contentContainer.replaceChild(fresh, old);
    releaseRow(old);
    measureRendered();
    updateSpacers();
    holdRow(fresh, edge);
  }

  /** Close the open editor. With `notify`, an editor that held focus hands it back. */
  function closeEdit(notify: boolean): void {
    if (edit === null) return;
    const { messageId, session } = edit;
    const hadFocus = notify && editHoldsFocus();
    edit = null;
    editGen++;
    editRefocus = false;
    session?.destroy();
    replaceRenderedRow(messageId);
    if (hadFocus) options.onEditEnd?.();
  }

  /** An editor whose message left the list (deleted, or a window swap) closes. */
  function dropGoneEdit(hadFocus: boolean): void {
    if (edit === null || allMessages.some((m) => m.id === edit?.messageId)) return;
    const { session } = edit;
    edit = null;
    editRefocus = false;
    editGen++;
    session?.destroy();
    if (hadFocus) options.onEditEnd?.();
  }

  /** After the editor grew, keep its bottom (where the caret is) inside the view. */
  function keepEditorCaretInView(): void {
    if (root === null || !editHoldsFocus()) return;
    const box = edit?.session?.element;
    if (box === undefined) return;
    const over = box.getBoundingClientRect().bottom - root.getBoundingClientRect().bottom;
    if (over > 0) setScrollTop(root.scrollTop + over);
  }

  function startEdit(
    messageId: number,
    text?: string,
    opts?: { readonly focus?: boolean },
  ): boolean {
    const takeFocus = opts?.focus !== false;
    if (root === null) return false;
    const msg = allMessages.find((m) => m.id === messageId);
    if (msg === undefined || msg.user.id !== options.currentUserId || msg.status !== "sent") {
      return false;
    }
    // A server-written row (call log, group event) is read-only.
    if (isServerRowKind(msg.kind)) return false;
    // A sticker message has no text to edit; the server refuses it.
    if (msg.sticker !== undefined) return false;
    if (edit?.messageId === messageId) {
      if (takeFocus) edit.session?.focusEnd();
      return true;
    }
    closeEdit(false);
    editRefocus = false;
    const gen = ++editGen;
    edit = { messageId, session: null, gen };
    // Stored `<@id>` / `<@&id>` tokens read as `@name` in the box, and the
    // spans left intact turn back into tokens on save.
    const names = {
      user: (id: number) => {
        const member = membersStore.getState().members.get(id);
        return member === undefined ? undefined : memberDisplayName(member);
      },
      role: (id: number) => channelsStore.getState().roles.find((r) => r.id === id)?.name,
    };
    const shown = tokensToPickedText(msg.content, names);
    // A restored edit draft (failed save) is converted the same way.
    const restored = text === undefined ? shown : tokensToPickedText(text, names);
    const startText = restored.text;
    withInlineEdit(
      (m) => {
        if (edit === null || edit.gen !== gen || disposable.signal.aborted) return;
        const session = m.createInlineEdit({
          messageId,
          text: startText,
          onSave: (content) => {
            // Without the capability the box showed the raw text; save it as is.
            const picks = idMentionsEnabled() ? [...shown.picks, ...restored.picks] : [];
            if (options.onEditSave(messageId, applyPickedMentions(content, picks))) {
              closeEdit(true);
            }
          },
          onCancel: () => closeEdit(true),
          onEmpty: () => options.onEmptyEdit(messageId),
        });
        edit.session = session;
        replaceRenderedRow(messageId);
        const idx = virtualItems.findIndex(
          (it) => it.kind === "message" && it.message.id === messageId,
        );
        const row = idx === -1 ? undefined : renderedRowAt(idx);
        const visible =
          row !== undefined &&
          root !== null &&
          edgeOf(row) >= 0 &&
          edgeOf(row) + row.getBoundingClientRect().height <= root.clientHeight;
        // Already on screen: leave the view alone. Otherwise bring the row in.
        // A quiet restore never moves the view or the focus.
        if (!takeFocus) return;
        if (!visible && idx !== -1) revealIndex(idx, false, false);
        session.focusEnd();
      },
      () => {
        // The editor chunk failed to load: nothing is open, so nothing is "editing".
        if (edit !== null && edit.gen === gen && edit.session === null) edit = null;
      },
    );
    return true;
  }

  function cancelEdit(): void {
    closeEdit(true);
  }

  function isEditing(): boolean {
    return edit !== null;
  }

  return {
    mount,
    destroy,
    scrollToMessage,
    markReadAndJumpToPresent,
    scrollPage,
    startEdit,
    cancelEdit,
    isEditing,
  };
}
