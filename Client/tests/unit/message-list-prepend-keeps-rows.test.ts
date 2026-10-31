/**
 * A history page landing above the reader keeps the rows already drawn: the
 * window's indices shift, the spacers and the reading position follow in the
 * same task, and no rendered row is rebuilt (so no image is fetched, decoded
 * or frozen again). OC-0248 (message-list-prepend-scroll-anchor.test.ts) pins
 * the reading position; this file pins that the DOM is kept.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { observeMediaMock, discardMediaMock, fetchImageAsObjectUrlMock, brokerImageMock } =
  vi.hoisted(() => ({
    brokerImageMock: vi.fn(() => Promise.resolve({ ok: true, value: new Blob(["x"]) })),
    observeMediaMock: vi.fn(),
    discardMediaMock: vi.fn(),
    fetchImageAsObjectUrlMock: vi.fn((_url: string) =>
      Promise.resolve("data:image/png;base64,AAAA"),
    ),
  }));
vi.mock("../../src/features/content-consent/external", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/content-consent/external")>()),
  externalAllowed: () => true,
}));
vi.mock("@lib/prefs/mediaVisibility", () => ({
  observeMedia: observeMediaMock,
  discardMedia: discardMediaMock,
}));
vi.mock("../../src/platform/desktop/externalContent", () => ({
  externalContent: {
    preview: vi.fn(),
    image: brokerImageMock,
  },
}));
vi.mock("../../src/features/messaging/content/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/features/messaging/content/attachments")>();
  return { ...actual, fetchImageAsObjectUrl: fetchImageAsObjectUrlMock };
});

import { createMessageList } from "@components/MessageList";
import type { MessageListOptions } from "@components/MessageList";
import { messagesStore } from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { setChannels, setActiveChannel } from "@stores/channels.store";
import { resetMembersState } from "../helpers/storeResets";
import "../helpers/resizeObserverStub";
import { makeListOptions, stubTallRowLayout } from "../helpers/messageListHarness";
import { buildMessage } from "../helpers/messageFactory";

const CHANNEL_ID = 1;

function makeMessage(id: number, over: Partial<Message> = {}): Message {
  return buildMessage(
    { id, ...over },
    {
      channelId: CHANNEL_ID,
      // One author per row with its own picture, so a refetch is attributable.
      user: { id: 1000 + id, username: `User${id}`, avatar: `/api/v1/files/av${id}` },
      content: `Message ${id} https://example.com/pic${id}.gif`,
      // 10 minutes apart on one UTC day: never grouped, one day divider.
      timestamp: new Date(Date.UTC(2024, 0, 15, 0, id * 10)).toISOString(),
    },
  );
}

function range(from: number, to: number, over: Partial<Message> = {}): Message[] {
  return Array.from({ length: to - from + 1 }, (_, i) => makeMessage(from + i, over));
}

function setMessages(messages: readonly Message[]): void {
  messagesStore.setState((prev) => {
    const next = new Map(prev.messagesByChannel);
    next.set(CHANNEL_ID, [...messages]);
    return { ...prev, messagesByChannel: next };
  });
}

describe("MessageList — a history page keeps the rendered rows", () => {
  let container: HTMLDivElement;
  let list: ReturnType<typeof createMessageList> | null = null;
  let options: MessageListOptions;
  let restoreLayout: () => void;

  const rootEl = (): HTMLDivElement => container.querySelector(".messages-container")!;
  const row = (id: number): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid='message-${id}']`);
  const spacer = (): number =>
    parseFloat(container.querySelector<HTMLElement>(".virtual-spacer-top")!.style.height);
  const rowsOf = (ids: readonly number[]): Map<number, HTMLElement> =>
    new Map(ids.map((id) => [id, row(id)!]));
  const imgsOf = (ids: readonly number[]): Set<Element> =>
    new Set(ids.flatMap((id) => [...row(id)!.querySelectorAll("img")]));
  const mount = (): void => {
    list = createMessageList(options);
    list.mount(container);
  };
  /** Let the mount's own scroll-to-bottom frame run before the test scrolls. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));
  const scrollNearTop = async (): Promise<void> => {
    rootEl().scrollTop = 40;
    rootEl().dispatchEvent(new Event("scroll"));
    // Let the scroll frame it queued run, so a later scroll queues a new one.
    await new Promise((r) => setTimeout(r, 40));
  };
  const expectSameNodes = (kept: ReadonlyMap<number, HTMLElement>): void => {
    for (const [id, el] of kept) {
      expect(row(id), `row ${id}`).toBe(el);
      expect(el.isConnected).toBe(true);
    }
  };

  beforeEach(() => {
    messagesStore.setState(() => ({
      messagesByChannel: new Map(),
      pendingSends: new Map(),
      loadedChannels: new Set(),
      hasMore: new Map([[CHANNEL_ID, true]]),
      historyLoadState: new Map(),
      detachedChannels: new Set(),
    }));
    resetMembersState();
    setChannels([]);
    setActiveChannel(null);
    observeMediaMock.mockClear();
    discardMediaMock.mockClear();
    fetchImageAsObjectUrlMock.mockClear();
    brokerImageMock.mockClear();
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => {} }),
    );
    restoreLayout = stubTallRowLayout();
    container = document.createElement("div");
    document.body.appendChild(container);
    options = makeListOptions({ channelId: CHANNEL_ID, currentUserId: 1063, onEditEnd: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    list?.destroy?.();
    list = null;
    container.remove();
    restoreLayout();
  });

  const KEPT = [61, 62, 63, 64, 65, 66, 67, 68, 69, 70];

  it("keeps the same row nodes and loads no image again", async () => {
    const initial = range(61, 120);
    setMessages(initial);
    mount();
    await settle();
    await scrollNearTop();
    const kept = rowsOf(KEPT);
    const keptImgs = imgsOf(KEPT);
    expect(keptImgs.size).toBe(KEPT.length * 2); // avatar and inline image
    await vi.waitFor(() => expect(fetchImageAsObjectUrlMock).toHaveBeenCalled());
    const avatarsFetched = fetchImageAsObjectUrlMock.mock.calls.length;
    observeMediaMock.mockClear();
    discardMediaMock.mockClear();
    fetchImageAsObjectUrlMock.mockClear();
    const top = rootEl().scrollTop;

    setMessages([...range(11, 60), ...initial]);
    messagesStore.flush();

    expectSameNodes(kept);
    // Nothing the reader was looking at was released, observed or fetched again.
    for (const img of keptImgs) {
      expect(discardMediaMock).not.toHaveBeenCalledWith(img);
      expect(observeMediaMock).not.toHaveBeenCalledWith(img, expect.anything());
    }
    expect(observeMediaMock.mock.calls.every(([img]) => !keptImgs.has(img as Element))).toBe(true);
    const refetched = fetchImageAsObjectUrlMock.mock.calls.map((c) => c[0]);
    for (const id of KEPT) expect(refetched).not.toContain(`/api/v1/files/av${id}`);
    // The page above is drawn by the slide, not by a rebuild of the window.
    expect(refetched.length).toBeLessThan(avatarsFetched);
    expect(row(11)).toBeNull();
    // The reading position moved down by the page, and the spacer by the same.
    expect(rootEl().scrollTop).toBeGreaterThan(top + 1000);
    expect(spacer()).toBeGreaterThan(1000);
  });

  it("keeps the rows when the message cap also trims the newest end", async () => {
    const initial = range(61, 120);
    setMessages(initial);
    mount();
    await settle();
    await scrollNearTop();
    const kept = rowsOf(KEPT);
    expect(row(120)).toBeNull();
    fetchImageAsObjectUrlMock.mockClear();

    // A page of 20 lands and the 20 newest rows leave, as at the 500-row cap.
    setMessages([...range(41, 60), ...initial.slice(0, 40)]);
    messagesStore.flush();

    expectSameNodes(kept);
    expect(row(120)).toBeNull();
    const refetched = fetchImageAsObjectUrlMock.mock.calls.map((c) => c[0]);
    for (const id of KEPT) expect(refetched).not.toContain(`/api/v1/files/av${id}`);
    expect(rootEl().scrollTop).toBeGreaterThan(40 + 500);
  });

  it("keeps an open editor, and its focus, in a kept row", async () => {
    const initial = range(61, 120);
    setMessages(initial);
    mount();
    await settle();
    await scrollNearTop();
    expect(list!.startEdit(63)).toBe(true);
    await vi.waitFor(() =>
      expect(container.querySelector("[data-testid='msg-edit-input-63']")).not.toBeNull(),
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "[data-testid='msg-edit-input-63']",
    )!;
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    const kept = rowsOf(KEPT);

    setMessages([...range(11, 60), ...initial]);
    messagesStore.flush();

    expectSameNodes(kept);
    expect(container.querySelector("[data-testid='msg-edit-input-63']")).toBe(textarea);
    expect(row(63)!.contains(textarea)).toBe(true);
    expect(document.activeElement).toBe(textarea);
  });

  it("a prepend between a queued scroll frame and its run does not rebuild", async () => {
    const initial = range(61, 120);
    setMessages(initial);
    mount();
    await settle();
    await scrollNearTop();
    const kept = rowsOf(KEPT);

    // Hold the next frame: handleScroll queues its renderWindow behind it.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    });
    rootEl().scrollTop = 30;
    rootEl().dispatchEvent(new Event("scroll"));
    expect(frames.length).toBeGreaterThan(0);

    setMessages([...range(11, 60), ...initial]);
    messagesStore.flush();
    fetchImageAsObjectUrlMock.mockClear();
    // The frame runs against the shifted indices.
    for (const cb of frames.splice(0)) cb(0);

    expectSameNodes(kept);
    const refetched = fetchImageAsObjectUrlMock.mock.calls.map((c) => c[0]);
    for (const id of KEPT) expect(refetched).not.toContain(`/api/v1/files/av${id}`);
    // The rows now in the window are the ones around the reader, once each.
    const ids = [...container.querySelectorAll<HTMLElement>(".virtual-content > .message")].map(
      (el) => el.dataset.testid,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a page of only deleted messages changes nothing", async () => {
    const initial = range(61, 120);
    setMessages(initial);
    mount();
    await settle();
    await scrollNearTop();
    const kept = rowsOf(KEPT);
    const top = rootEl().scrollTop;
    const before = spacer();
    const children = [...container.querySelectorAll(".virtual-content > *")];
    fetchImageAsObjectUrlMock.mockClear();
    observeMediaMock.mockClear();
    discardMediaMock.mockClear();

    setMessages([...range(11, 60, { deleted: true }), ...initial]);
    messagesStore.flush();

    expectSameNodes(kept);
    expect([...container.querySelectorAll(".virtual-content > *")]).toEqual(children);
    expect(spacer()).toBe(before);
    expect(rootEl().scrollTop).toBe(top);
    expect(fetchImageAsObjectUrlMock).not.toHaveBeenCalled();
    expect(observeMediaMock).not.toHaveBeenCalled();
    expect(discardMediaMock).not.toHaveBeenCalled();
  });
});
