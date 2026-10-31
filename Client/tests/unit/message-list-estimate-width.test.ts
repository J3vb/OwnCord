/**
 * Rows no one has measured are estimated at the list's width. The width is
 * only known once the list is on screen, so when the ResizeObserver reports a
 * different one the unmeasured estimates are redone, and the reading position
 * holds across it.
 */
import { stubCapturingResizeObserver } from "../helpers/resizeObserverStub";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

const { observers } = vi.hoisted(() => ({ observers: [] as Array<() => void> }));

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { buildMessage } from "../helpers/messageFactory";
import { resetMessagesState, resetMembersState } from "../helpers/storeResets";
import { makeListOptions } from "../helpers/messageListHarness";

const CHANNEL_ID = 1;

function makeMessage(id: number): Message {
  return buildMessage(
    { id },
    {
      channelId: CHANNEL_ID,
      user: { id: 1000 + id, username: `User${id}`, avatar: "" },
      // ~600 characters: wraps to a different line count at 900 px and 400 px.
      content: `Message ${id} ${"lorem ipsum ".repeat(50)}`,
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    },
  );
}

describe("MessageList: estimates follow the list's width", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let width = 900;
  const saved: Record<string, PropertyDescriptor | undefined> = {};

  const rootEl = (): HTMLDivElement => container.querySelector(".messages-container")!;
  const topSpacer = (): number =>
    parseFloat(container.querySelector<HTMLElement>(".virtual-spacer-top")!.style.height);
  const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

  useMountContainer(
    (c) => {
      container = c;
    },
    () => {
      list?.destroy?.();
      list = null;
      vi.unstubAllGlobals();
      for (const [name, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(HTMLElement.prototype, name, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      }
      width = 900;
    },
  );

  beforeEach(() => {
    observers.length = 0;
    stubCapturingResizeObserver(observers);
    for (const name of ["scrollHeight", "offsetHeight", "clientWidth", "clientHeight"]) {
      saved[name] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    }
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1_000_000,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains("message") ? 100 : 32;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => width,
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    resetMessagesState();
    resetMembersState();
    setChannels([]);
    setActiveChannel(null);
  });

  it("re-estimates unmeasured rows at a new width and holds the reading position", async () => {
    const messages = Array.from({ length: 200 }, (_, i) => makeMessage(i + 1));
    messagesStore.setState((prev) => {
      const next = new Map(prev.messagesByChannel);
      next.set(CHANNEL_ID, messages);
      return { ...prev, messagesByChannel: next };
    });
    const options: MessageListOptions = makeListOptions({
      channelId: CHANNEL_ID,
      onEditEnd: vi.fn(),
    });
    list = createMessageList(options);
    list.mount(container);
    await frame();

    // Read part-way down so rows above and below the window stay unmeasured.
    rootEl().scrollTop = 30000;
    rootEl().dispatchEvent(new Event("scroll"));
    await frame();
    const topBefore = topSpacer();
    const offsetBefore = rootEl().scrollTop - topBefore;
    expect(topBefore).toBeGreaterThan(0);

    width = 400; // the list was narrower than the 900px the estimates assumed
    for (const cb of observers) cb();
    await frame();

    // More wrapped lines per unmeasured row above: the spacer grew ...
    expect(topSpacer()).toBeGreaterThan(topBefore);
    // ... and the reader did not move relative to the rows on screen.
    expect(rootEl().scrollTop - topSpacer()).toBeCloseTo(offsetBefore, 0);
  });

  it("leaves the estimates alone when the width did not change", async () => {
    const messages = Array.from({ length: 200 }, (_, i) => makeMessage(i + 1));
    messagesStore.setState((prev) => {
      const next = new Map(prev.messagesByChannel);
      next.set(CHANNEL_ID, messages);
      return { ...prev, messagesByChannel: next };
    });
    list = createMessageList(makeListOptions({ channelId: CHANNEL_ID, onEditEnd: vi.fn() }));
    list.mount(container);
    await frame();
    rootEl().scrollTop = 30000;
    rootEl().dispatchEvent(new Event("scroll"));
    await frame();
    const topBefore = topSpacer();

    for (const cb of observers) cb();
    await frame();

    expect(topSpacer()).toBe(topBefore);
  });
});
