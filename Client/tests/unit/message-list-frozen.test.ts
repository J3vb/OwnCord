/**
 * Pins the message list's pure steps (the row height estimate and the NEW
 * divider latch) to frozen copies of the implementations they had before they
 * were split into named helpers. The copies below are deliberately verbatim
 * (the divider copy takes the state as an argument instead of closing over it)
 * and must not be edited to follow the live code.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";

import {
  isAudioMime,
  isGalleryImage,
  isImageMime,
  isVideoAttachment,
  resolveServerUrl,
  thumbnailUrl,
} from "../../src/features/messaging/content/attachments";
import {
  ATTACHMENT_BOX_MAX_H,
  fitImageBox,
  getImageBox,
  knownImageHeight,
  setImageBox,
  clearImageSizes,
} from "../../src/features/messaging/content/imageSizes";
import { extractUrls, isDirectImageUrl } from "../../src/features/messaging/content/media";
import {
  estimateItemHeight,
  firstUnreadIndex,
  type VirtualItem,
} from "../../src/features/messaging/message-list/virtualItems";
import {
  resolveNewDividerIndex,
  storeDividerEnv,
  type DividerLatch,
} from "../../src/features/messaging/message-list/newDivider";
import {
  getChannelMessages,
  getHistoryLoadState,
  isWindowDetached,
  type Message,
} from "@stores/messages.store";
import { buildMessage } from "../helpers/messageFactory";
import { resetMessagesState } from "../helpers/storeResets";

// ---- Frozen copies -----------------------------------------------------------

/** Regex for direct image URLs in message content. */
const IMAGE_URL_RE = /\.(?:png|jpe?g|gif|webp)(?:\?[^\s]*)?(?:\s|$)/i;

/** Regex for YouTube URLs in message content. */
const YOUTUBE_URL_RE =
  /(?:(?:www\.|m\.|music\.)?youtube(?:-nocookie)?\.com\/(?:watch|embed\/|shorts\/|live\/)|youtu\.be\/)/i;

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

function frozenEstimateItemHeight(
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

function frozenResolveNewDividerIndex(
  st: DividerLatch & { options: { channelId: number } },
  messages: readonly Message[],
): number {
  if (st.newDividerAnchorId !== null) {
    const at = messages.findIndex((m) => m.id === st.newDividerAnchorId);
    if (at === -1) {
      // The anchor was deleted (the store keeps it as a tombstone): the line
      // moves to the first message after it, or waits when there is none.
      const anchorId = st.newDividerAnchorId;
      const tombstone = getChannelMessages(st.options.channelId).some(
        (m) => m.id === anchorId && m.deleted,
      );
      if (tombstone) {
        const nextAt = messages.findIndex((m) => m.id > anchorId);
        if (nextAt === -1) return -1;
        st.newDividerAnchorId = messages[nextAt]!.id;
        return nextAt;
      }
    }
    if (at !== -1 || st.linePointer === undefined) return at;
    // The anchor left the window (a jump): place the line again by pointer.
    st.newDividerAnchorId = null;
  }
  // The first loaded message above the pointer, latched like the count-based
  // one — except at the top of the window, where older history may still
  // arrive above it and move the true boundary.
  const byPointer = (): number => {
    const idx = messages.findIndex((m) => m.id > (st.linePointer ?? 0));
    if (idx > 0) st.newDividerAnchorId = messages[idx]!.id;
    return idx;
  };
  // An around-window centred on a jumped-to message is not the tail: counting
  // back from its end would mark an arbitrary row. Detachment is read here,
  // not at mount, because a cross-channel jump detaches after the mount.
  if (isWindowDetached(st.options.channelId)) {
    st.newDividerDeferred = false;
    // No divider will exist to open at, and a pending open left armed would
    // scroll the reader up to the line once the tail returns.
    st.openAtDividerPending = false;
    // A pointer places the line inside the around-window too (never scrolled to).
    return st.linePointer === undefined ? -1 : byPointer();
  }
  // A revisit renders the cached window while its tail is refetched.
  // Those rows predate what arrived while away, so counting back from their
  // end would mark messages already read; wait for the fetched tail.
  st.newDividerDeferred =
    st.unreadOnOpen > 0 && getHistoryLoadState(st.options.channelId) === "loading";
  if (st.newDividerDeferred) return -1;
  if (st.linePointer !== undefined) {
    // Only a channel that had unread when opened: with none, the first message
    // above the pointer is just the first live arrival.
    return st.unreadOnOpen > 0 ? byPointer() : -1;
  }
  const idx = firstUnreadIndex(messages, st.unreadOnOpen);
  const anchor = idx !== -1 ? messages[idx] : undefined;
  if (anchor !== undefined && anchor.id !== 0 && messages.length >= st.unreadOnOpen) {
    st.newDividerAnchorId = anchor.id;
  }
  return idx;
}

// ---- Estimate ----------------------------------------------------------------

const URLS = [
  "https://img.example/a.png",
  "https://img.example/b.gif",
  "https://img.example/c.jpg",
  "https://img.example/page",
];

const attachmentArb = fc.record(
  {
    id: fc.constant("a"),
    filename: fc.constant("f"),
    size: fc.constant(1),
    mime: fc.constantFrom("image/png", "image/gif", "video/mp4", "audio/mpeg", "text/plain"),
    url: fc.constantFrom("/api/v1/files/1", "/api/v1/files/2", "javascript:x"),
    width: fc.integer({ min: 1, max: 2000 }),
    height: fc.integer({ min: 1, max: 2000 }),
  },
  { requiredKeys: ["id", "filename", "size", "mime", "url"] },
);

const contentArb = fc
  .array(
    fc.constantFrom(
      "hello world ",
      "\n",
      "x".repeat(70),
      ...URLS,
      " https://youtu.be/abc ",
      "`https://img.example/a.png`",
      " ",
    ),
    { maxLength: 8 },
  )
  .map((parts) => parts.join(""));

const messageItemArb: fc.Arbitrary<VirtualItem> = fc
  .record({
    content: contentArb,
    attachments: fc.array(attachmentArb, { maxLength: 11 }),
    isGrouped: fc.boolean(),
  })
  .map(({ content, attachments, isGrouped }) => ({
    kind: "message" as const,
    isGrouped,
    message: buildMessage({ id: 1, content, attachments }),
  }));

const itemArb: fc.Arbitrary<VirtualItem> = fc.oneof(
  { weight: 8, arbitrary: messageItemArb },
  { weight: 1, arbitrary: fc.constant({ kind: "new-divider" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "divider" as const, timestamp: "t" }) },
);

const boxesArb = fc.array(
  fc.record({
    url: fc.constantFrom(...URLS),
    w: fc.integer({ min: 1, max: 400 }),
    h: fc.integer({ min: 1, max: 350 }),
  }),
  { maxLength: 4 },
);

describe("row height estimate keeps its pre-split behaviour", () => {
  beforeEach(() => {
    clearImageSizes();
  });

  it("matches the frozen copy for every item and width", () => {
    fc.assert(
      fc.property(
        itemArb,
        fc.option(fc.integer({ min: 0, max: 1600 }), { nil: undefined }),
        boxesArb,
        (item, width, boxes) => {
          clearImageSizes();
          for (const b of boxes) setImageBox(b.url, { w: b.w, h: b.h, measured: true });
          expect(estimateItemHeight(item, width)).toBe(frozenEstimateItemHeight(item, width));
        },
      ),
      { numRuns: 1000 },
    );
  }, 60_000);
});

// ---- NEW divider -------------------------------------------------------------

const CHANNEL = 5;

interface Seed {
  readonly messages: readonly Message[];
  readonly stored: readonly Message[];
  readonly detached: boolean;
  readonly loading: "loading" | "error" | null;
  readonly latch: {
    newDividerAnchorId: number | null;
    newDividerDeferred: boolean;
    openAtDividerPending: boolean;
    linePointer: number | undefined;
    unreadOnOpen: number;
  };
}

const rowArb = (deleted: boolean): fc.Arbitrary<Message> =>
  fc.integer({ min: 0, max: 14 }).map((id) => buildMessage({ id, channelId: CHANNEL, deleted }));

const seedArb: fc.Arbitrary<Seed> = fc.record({
  messages: fc
    .uniqueArray(fc.integer({ min: 1, max: 14 }), { maxLength: 10 })
    .chain((ids) =>
      fc
        .integer({ min: 0, max: 2 })
        .map((zeros) => [...ids.toSorted((a, b) => a - b), ...Array<number>(zeros).fill(0)]),
    )
    .map((ids) => ids.map((id) => buildMessage({ id, channelId: CHANNEL }))),
  stored: fc.array(rowArb(true), { maxLength: 6 }),
  detached: fc.boolean(),
  loading: fc.constantFrom("loading" as const, "error" as const, null),
  latch: fc.record({
    newDividerAnchorId: fc.option(fc.integer({ min: 0, max: 15 }), { nil: null }),
    newDividerDeferred: fc.boolean(),
    openAtDividerPending: fc.boolean(),
    linePointer: fc.option(fc.integer({ min: 0, max: 14 }), { nil: undefined }),
    unreadOnOpen: fc.oneof(fc.integer({ min: 0, max: 12 }), fc.constant(Number.POSITIVE_INFINITY)),
  }),
});

function seedStores(seed: Seed): void {
  resetMessagesState({
    messagesByChannel: new Map([[CHANNEL, [...seed.messages, ...seed.stored]]]),
    detachedChannels: new Set(seed.detached ? [CHANNEL] : []),
    historyLoadState: new Map(seed.loading === null ? [] : [[CHANNEL, seed.loading]]),
  });
}

describe("NEW divider latch keeps its pre-split behaviour", () => {
  beforeEach(() => {
    resetMessagesState();
  });

  it("returns the same index and leaves the same latch as the frozen copy", () => {
    fc.assert(
      fc.property(seedArb, (seed) => {
        seedStores(seed);
        const oldSt = { ...seed.latch, options: { channelId: CHANNEL } };
        const newSt: DividerLatch = { ...seed.latch };
        const oldIdx = frozenResolveNewDividerIndex(oldSt, seed.messages);
        const newIdx = resolveNewDividerIndex(newSt, seed.messages, storeDividerEnv(CHANNEL));
        expect(newIdx).toBe(oldIdx);
        const { options: _options, ...oldLatch } = oldSt;
        expect(newSt).toEqual(oldLatch);
      }),
      { numRuns: 2000 },
    );
  }, 60_000);
});
