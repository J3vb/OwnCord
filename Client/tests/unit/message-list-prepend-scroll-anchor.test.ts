/**
 * OC-0248: prepending a history page (loadOlderMessages -> prependMessages)
 * must keep whatever message the reader was actually looking at in view.
 * renderAll() only has a scroll-anchor branch for "was at the bottom"; a
 * prepend takes the non-append, non-bottom path and currently leaves
 * root.scrollTop untouched, which after the prepend points at completely
 * different (older) content.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { buildMessage } from "../helpers/messageFactory";
import {
  makeListOptions,
  resetStoresAndChannels,
  setHasMore,
  setMessages,
} from "../helpers/messageListHarness";
import "../helpers/resizeObserverStub";

const CHANNEL_ID = 1;

function makeMessage(id: number): Message {
  return buildMessage(
    { id },
    {
      channelId: CHANNEL_ID,
      // 10 minutes apart, on the same UTC day, and past GROUP_THRESHOLD_MS
      // (7 minutes) so shouldGroup never merges two of these rows — every
      // message renders at its full (ungrouped) height.
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    },
  );
}

describe("MessageList — history prepend keeps the reading position", () => {
  let container: HTMLDivElement;
  let msgList: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    resetStoresAndChannels();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions({ channelId: CHANNEL_ID });

    // jsdom never lays anything out, so scrollHeight/clientHeight are always
    // 0 — which makes isNearBottom() (scrollHeight - scrollTop - clientHeight
    // < 100) unconditionally TRUE regardless of scrollTop, hiding this bug
    // entirely (it only manifests when the reader is scrolled away from the
    // bottom). Stub a real gap so isNearBottom reflects the scrollTop we set.
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(): number {
        return 100_000;
      },
    });
  });

  afterEach(() => {
    msgList?.destroy?.();
    msgList = null;
    container.remove();
    if (scrollHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });

  function mount(): void {
    msgList = createMessageList(options);
    msgList.mount(container);
  }

  it("keeps the previously-topmost message rendered after a history page is prepended", async () => {
    // The currently loaded window: 50 messages, ids 51..100 (oldest loaded
    // message is 51).
    const initial = Array.from({ length: 50 }, (_, i) => makeMessage(51 + i));
    setMessages(CHANNEL_ID, initial);
    setHasMore(CHANNEL_ID, true);
    mount();

    const root = container.querySelector(".messages-container") as HTMLDivElement;

    // Scroll near the top -- exactly the state that fires loadOlderMessages
    // in production (handleScroll's scrollTop < SCROLL_TOP_THRESHOLD(50)
    // check) -- landing inside message-51's row, the oldest loaded message.
    root.scrollTop = 40;
    root.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    // A history page of 50 older messages (ids 1..50) is prepended in front
    // of the array -- a real prependMessages call. This is not a suffix
    // extension (allMessages[0] changes), so the store subscriber's
    // tryAppendMessages() bails and falls through to renderAll().
    const older = Array.from({ length: 50 }, (_, i) => makeMessage(1 + i));
    setMessages(CHANNEL_ID, [...older, ...initial]);
    messagesStore.flush();

    // Message 51 -- what the reader was actually looking at -- must still be
    // rendered near the top of the (virtualized) window. Before the fix,
    // root.scrollTop is left at ~40px, which after the prepend now falls
    // inside message-1's row (the new oldest message) instead: the reader is
    // thrown ~50 messages backwards.
    expect(container.querySelector('[data-testid="message-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-51"]')).not.toBeNull();

    // The scroll position must have moved forward by roughly the height of
    // the prepended page, not stayed pinned at its pre-prepend value.
    expect(root.scrollTop).toBeGreaterThan(1000);
  });

  // A capped unread count keeps the NEW line at the top of the loaded window,
  // so it moves up with every prepended page: it is no anchor for the reader.
  it("keeps the reading position when the NEW line sits at the top of the window", async () => {
    const initial = Array.from({ length: 50 }, (_, i) => makeMessage(51 + i));
    setMessages(CHANNEL_ID, initial);
    setHasMore(CHANNEL_ID, true);
    setChannels([
      {
        id: CHANNEL_ID,
        name: "general",
        type: "text",
        category: null,
        position: 0,
        unread_count: 100,
        mention_count: 0,
      },
    ]);
    setActiveChannel(CHANNEL_ID);
    mount();
    expect(container.querySelector('[data-testid="new-messages-divider"]')).not.toBeNull();

    const root = container.querySelector(".messages-container") as HTMLDivElement;
    // Inside the NEW line, just above message 51.
    root.scrollTop = 40;
    root.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    const older = Array.from({ length: 50 }, (_, i) => makeMessage(1 + i));
    setMessages(CHANNEL_ID, [...older, ...initial]);
    messagesStore.flush();

    expect(container.querySelector('[data-testid="message-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-51"]')).not.toBeNull();
    expect(root.scrollTop).toBeGreaterThan(1000);
  });
  // The rows a prepend inserts above the reader are not rendered when the
  // anchor is first applied, so their heights are estimates. Once renderWindow
  // has built and measured them, the anchored row must still sit where it was
  // in the viewport: the scroll offset is re-applied against the measured
  // heights, instead of staying at the estimate-derived value.
  it("keeps the anchored row at its viewport offset once the prepended rows are measured", async () => {
    const MEASURED_ROW = 100; // every rendered message row (the estimate is 61)
    const MEASURED_DIVIDER = 32;
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains("message") ? MEASURED_ROW : MEASURED_DIVIDER;
      },
    });
    try {
      const initial = Array.from({ length: 50 }, (_, i) => makeMessage(51 + i));
      setMessages(CHANNEL_ID, initial);
      setHasMore(CHANNEL_ID, true);
      mount();
      const root = container.querySelector(".messages-container") as HTMLDivElement;
      // 8px into message 51, the oldest loaded row, right under the day divider.
      root.scrollTop = MEASURED_DIVIDER + 8;
      root.dispatchEvent(new Event("scroll"));
      await Promise.resolve();

      const older = Array.from({ length: 50 }, (_, i) => makeMessage(1 + i));
      setMessages(CHANNEL_ID, [...older, ...initial]);
      messagesStore.flush();

      // Where the anchored row really is: the top spacer plus every rendered
      // row above it, as the browser would lay them out.
      const rows = [...container.querySelectorAll<HTMLElement>(".virtual-content > *")];
      const anchorRow = container.querySelector<HTMLElement>('[data-testid="message-51"]');
      expect(anchorRow).not.toBeNull();
      const spacer = parseFloat(
        container.querySelector<HTMLElement>(".virtual-spacer-top")!.style.height,
      );
      const above = rows
        .slice(0, rows.indexOf(anchorRow!))
        .reduce((h, el) => h + el.offsetHeight, 0);
      expect(root.scrollTop).toBe(spacer + above + 8);
    } finally {
      if (offsetHeightDescriptor) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
      }
    }
  });
});
