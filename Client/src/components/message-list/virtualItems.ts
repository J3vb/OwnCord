/**
 * The list's virtual items: the rows a message list draws (messages, day and
 * NEW dividers, blocked runs) and the height each is estimated at before it
 * has been measured.
 */
import { isServerRowKind } from "@lib/text/messageKind";
import type { Message } from "@stores/messages.store";
import { isSameDay, shouldGroup } from "./renderers";
import {
  isAudioMime,
  isGalleryImage,
  isImageMime,
  isVideoAttachment,
  resolveServerUrl,
  thumbnailUrl,
} from "./attachments";
import { ATTACHMENT_BOX_MAX_H, fitImageBox, getImageBox, knownImageHeight } from "./imageSizes";
import { extractUrls, isDirectImageUrl } from "./media";

/** Regex for direct image URLs in message content. */
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?(?:\s|$)/i;

/** Regex for YouTube URLs in message content. */
const YOUTUBE_URL_RE =
  /(?:(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com\/(?:watch|embed\/|shorts\/|live\/)|youtu\.be\/)/i;

// -- Virtual item types -------------------------------------------------------

export interface VirtualItemMessage {
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
export function visibleMessages(list: readonly Message[]): readonly Message[] {
  return list.some((m) => m.deleted) ? list.filter((m) => !m.deleted) : list;
}

// -- Pre-process messages into virtual items ----------------------------------

/** Build virtual items for `messages`, with the NEW divider above index
 *  `newDividerAt` (-1 for none). Consecutive messages by an author in `blocked`
 *  become one run, broken by a day divider and by the NEW line; it is expanded
 *  when any of its ids is in `shown`. */
export function buildVirtualItems(
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
export function firstUnreadIndex(messages: readonly Message[], unreadOnOpen: number): number {
  if (unreadOnOpen <= 0 || messages.length === 0) return -1;
  return Math.max(0, messages.length - unreadOnOpen);
}

/** The stable key a virtual item is cached and matched by across rebuilds. */
export function keyOf(item: VirtualItem | undefined, index: number): string {
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
