/**
 * The thread panel's list callbacks: the reply-quote jump, and the pin, edit
 * and delete safety nets it shares with the channel list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MessageListOptions } from "../../src/features/messaging/MessageList";

const captured = vi.hoisted(() => ({ opts: null as unknown }));
const fakeList = vi.hoisted(() => ({
  mount: vi.fn(),
  destroy: vi.fn(),
  scrollToMessage: vi.fn((_id: number) => true),
  startEdit: vi.fn(() => true),
  cancelEdit: vi.fn(),
  isEditing: vi.fn(() => false),
  setReplyTarget: vi.fn(),
}));
vi.mock("../../src/features/messaging/MessageList", () => ({
  createMessageList: (opts: unknown) => {
    captured.opts = opts;
    return fakeList;
  },
}));
vi.mock("@lib/pendingMessages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/pendingMessages")>()),
  supportsMessageDeduplication: () => true,
}));

import { createThreadPanel } from "../../src/features/threads/ThreadPanel";
import { WsErrorCode } from "@lib/protocolTypes";
import { createThreadJump } from "../../src/features/threads/threadJump";
import { renderReplyRef } from "../../src/features/messaging/message-list/renderReplyRef";
import { messagingText } from "../../src/i18n/messaging";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import {
  messagesStore,
  type Message,
  resetMessagesStore,
  setMessagePinned,
} from "@stores/messages.store";
import { setConnectionStatus } from "@stores/ui.store";
import { resetThreadsStore, upsertThread } from "@stores/threads.store";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { expectConsole } from "../helpers/console";
import { createMockWsClient } from "../helpers/mock-ws";
import { buildResponse } from "../helpers/messageFactory";
import {
  ME,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { makeThread } from "../helpers/thread-fixtures";
import "../helpers/resizeObserverStub";

const PARENT = 1;
const THREAD = 91;

let ws: ReturnType<typeof createMockWsClient>;
let container: HTMLDivElement;
const toast = vi.fn();
const getMessagesAround = vi.fn();
const pinMessage = vi.fn();
const unpinMessage = vi.fn();
const api = {
  getConfig: () => ({ host: "h" }),
  getMessagesAround,
  pinMessage,
  unpinMessage,
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  discardUpload: vi.fn(async () => {}),
} as unknown as ApiClient;
const msgCtrl = {
  loadMessages: vi.fn(async () => {}),
  loadOlderMessages: vi.fn(async () => {}),
  loadNewerMessages: vi.fn(async () => {}),
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const listOpts = (): MessageListOptions => captured.opts as MessageListOptions;

function mountPanel() {
  const panel = createThreadPanel({
    ws: ws as unknown as WsClient,
    api,
    msgCtrl,
    threadId: THREAD,
    reactions: { handleReaction: vi.fn(), destroy: vi.fn() },
    showToast: toast,
    onClose: vi.fn(),
  });
  panel.mount(container);
  return panel;
}

function seedMessages(channel: number, messages: Message[]): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map(prev.messagesByChannel).set(channel, messages),
    loadedChannels: new Set(prev.loadedChannels).add(channel),
  }));
}

const threadRows = () => messagesStore.getState().messagesByChannel.get(THREAD) ?? [];
const sentOf = (type: string) => ws.getSentMessages().filter((m) => m.type === type);

beforeEach(() => {
  resetGateStores();
  resetMessagesStore();
  resetThreadsStore();
  signInAs("member");
  setChannel();
  applyReadyCapabilities({ threads: true });
  ws = createMockWsClient();
  setConnectionStatus("connected");
  container = document.createElement("div");
  document.body.appendChild(container);
  upsertThread(makeThread({ id: THREAD, parent_id: PARENT, starter_message_id: 1, owner_id: ME }));
  seedMessages(PARENT, [makeMessage({ id: 1, channelId: PARENT, content: "starter" })]);
  seedMessages(THREAD, [
    makeMessage({ id: 100, channelId: THREAD, content: "first" }),
    makeMessage({ id: 101, channelId: THREAD, content: "second" }),
  ]);
  for (const fn of [toast, getMessagesAround, pinMessage, unpinMessage]) fn.mockReset();
  for (const fn of Object.values(fakeList)) fn.mockClear();
  fakeList.scrollToMessage.mockImplementation((id: number) =>
    threadRows().some((m) => m.id === id),
  );
  fakeList.isEditing.mockReturnValue(false);
  fakeList.startEdit.mockReturnValue(true);
});
afterEach(() => {
  container.remove();
  document.body.replaceChildren();
  resetServerCapabilities();
  resetThreadsStore();
  resetMessagesStore();
  resetGateStores();
  vi.restoreAllMocks();
});

describe("reply quote in a thread", () => {
  it("scrolls inside the thread list when the parent is loaded", async () => {
    const panel = mountPanel();
    await flush();
    listOpts().onJumpToMessage?.(100);
    await flush();
    expect(fakeList.scrollToMessage).toHaveBeenCalledWith(100);
    expect(getMessagesAround).not.toHaveBeenCalled();
    panel.destroy?.();
  });

  it("loads the around-window for a parent that is not loaded, then scrolls", async () => {
    getMessagesAround.mockResolvedValue({
      messages: [buildResponse(50), buildResponse(51)],
      has_more_before: true,
      has_more_after: true,
    });
    const jump = createThreadJump({
      api,
      threadId: THREAD,
      signal: new AbortController().signal,
      getList: () => fakeList as never,
      showToast: toast,
      nextFrame: () => Promise.resolve(),
    });
    await jump(50);
    expect(getMessagesAround).toHaveBeenCalledWith(THREAD, 50, { limit: 50 });
    expect(threadRows().map((m) => m.id)).toEqual([50, 51]);
    expect(fakeList.scrollToMessage).toHaveBeenCalledWith(50);
  });

  it("installs nothing when the panel moves on before the around fetch lands", async () => {
    let land: (v: unknown) => void = () => {};
    getMessagesAround.mockReturnValue(new Promise((r) => (land = r)));
    const panel = mountPanel();
    await flush();
    listOpts().onJumpToMessage?.(50);
    await flush();
    expect(getMessagesAround).toHaveBeenCalledTimes(1);
    // The host destroys this panel when another thread opens.
    panel.destroy?.();
    fakeList.scrollToMessage.mockClear();
    land({ messages: [buildResponse(50)], has_more_before: false, has_more_after: false });
    await flush();
    expect(
      threadRows()
        .map((m) => m.id)
        .sort(),
    ).toEqual([100, 101]);
    expect(fakeList.scrollToMessage).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("renders the quote as plain text when no jump is wired", () => {
    const reply = makeMessage({ id: 2, replyTo: 100, content: "re" });
    const parent = makeMessage({ id: 100, content: "orig" });
    const ac = new AbortController();
    const { onJumpToMessage: _drop, ...noJump } = makeOpts();
    const bar = renderReplyRef(100, undefined, [parent, reply], noJump, ac.signal);
    expect(bar.getAttribute("role")).toBeNull();
    expect(bar.getAttribute("tabindex")).toBeNull();
    expect(bar.title).toBe("");
    const live = renderReplyRef(
      100,
      undefined,
      [parent, reply],
      makeOpts({ onJumpToMessage: vi.fn() }),
      ac.signal,
    );
    expect(live.getAttribute("role")).toBe("button");
    ac.abort();
  });
});

describe("pin in a thread", () => {
  it("sends one request when clicked twice while the first is in flight", async () => {
    let settle: () => void = () => {};
    pinMessage.mockReturnValue(new Promise<void>((r) => (settle = r)));
    const panel = mountPanel();
    await flush();
    listOpts().onPinClick?.(100, THREAD, false);
    listOpts().onPinClick?.(100, THREAD, false);
    expect(pinMessage).toHaveBeenCalledTimes(1);
    expect(unpinMessage).not.toHaveBeenCalled();
    unpinMessage.mockResolvedValue(undefined);
    settle();
    await flush();
    listOpts().onPinClick?.(100, THREAD, true);
    expect(unpinMessage).toHaveBeenCalledTimes(1);
    panel.destroy?.();
  });

  it("does not revert over a newer pin event when the request fails", async () => {
    let fail: (e: Error) => void = () => {};
    pinMessage.mockReturnValue(new Promise<void>((_, r) => (fail = r)));
    const panel = mountPanel();
    await flush();
    listOpts().onPinClick?.(100, THREAD, false);
    // chat_pinned for the same message lands first and holds the truth.
    setMessagePinned(THREAD, 100, true);
    fail(new Error("nope"));
    await flush();
    expectConsole("error", /Pin\/unpin failed/);
    expect(threadRows().find((m) => m.id === 100)?.pinned).toBe(true);
    expect(toast).toHaveBeenCalledWith(messagingText("toast.pinFailed"), "error");
    panel.destroy?.();
  });
});

describe("edit and delete in a thread", () => {
  it("restores the text when the edit frame cannot be sent", async () => {
    const panel = mountPanel();
    await flush();
    expect(listOpts().onEditSave?.(100, "changed")).toBe(true);
    const frame = sentOf("chat_edit")[0];
    ws.simulateSendFailure(frame!.id, "NETWORK");
    await flush();
    expect(fakeList.startEdit).toHaveBeenCalledWith(100, "changed", expect.anything());
    expect(toast).toHaveBeenCalledWith(messagingText("toast.editFailedRestored"), "error");
    panel.destroy?.();
  });

  it("restores the text when the connection drops with an edit in flight", async () => {
    const panel = mountPanel();
    await flush();
    listOpts().onEditSave?.(100, "changed");
    ws.connect();
    ws.simulateStateChange("reconnecting");
    await flush();
    expect(fakeList.startEdit).toHaveBeenCalledWith(100, "changed", expect.anything());
    panel.destroy?.();
  });

  it("stops tracking an edit once the server echoes it", async () => {
    const panel = mountPanel();
    await flush();
    listOpts().onEditSave?.(100, "changed");
    ws.simulate("chat_edited", { channel_id: THREAD, message_id: 100 });
    ws.connect();
    ws.simulateStateChange("reconnecting");
    await flush();
    expect(fakeList.startEdit).not.toHaveBeenCalled();
    panel.destroy?.();
  });

  it("settles a refused edit, so a later drop neither restores it again nor toasts", async () => {
    const panel = mountPanel();
    await flush();
    listOpts().onEditSave?.(100, "changed");
    const frame = sentOf("chat_edit")[0];
    ws.simulate("error", { code: WsErrorCode.FORBIDDEN, message: "" }, frame!.id);
    await flush();
    expect(fakeList.startEdit).toHaveBeenCalledTimes(1);
    ws.connect();
    ws.simulateStateChange("reconnecting");
    await flush();
    expect(fakeList.startEdit).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith(messagingText("toast.editFailedRestored"), "error");
    panel.destroy?.();
  });

  it("reports a delete frame that could not be sent", async () => {
    const panel = mountPanel();
    await flush();
    listOpts().onDeleteClick?.(100, true);
    const frame = sentOf("chat_delete")[0];
    expect(frame).toBeDefined();
    ws.simulateSendFailure(frame!.id, "NETWORK");
    expect(toast).toHaveBeenCalledWith(messagingText("toast.deleteFailed"), "error");
    panel.destroy?.();
  });
});
