import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const noteSeen = vi.hoisted(() => vi.fn());
vi.mock("@components/message-list/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@components/message-list/attachments")>()),
  fetchImageAsObjectUrl: vi.fn(async () => "blob:sticker"),
}));
// The pending-message queue is not activated in a unit test; a sticker send needs its dedup id.
vi.mock("@lib/pendingMessages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/pendingMessages")>()),
  supportsMessageDeduplication: () => true,
}));
vi.mock("@lib/read-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/read-state")>()),
  noteMessageSeen: noteSeen,
}));

import { createThreadPanel } from "@components/ThreadPanel";
import { createMessageList } from "@components/MessageList";
import { resumeThreadFocus, withThreadsStore } from "../../src/stores/threadsLoader";
import { createThreadPanelHost } from "../../src/pages/main-page/ThreadPanelHost";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import {
  isChannelLoaded,
  messagesStore,
  resetMessagesStore,
  type Message,
} from "@stores/messages.store";
import { safetyStore } from "../../src/features/safety/store";
import { setConnectionStatus } from "@stores/ui.store";
import { stickersStore, setStickers, clearStickers } from "@stores/stickers.store";
import {
  applyFollowUpdate,
  getThread,
  removeThread,
  resetThreadsStore,
  setFocusedThread,
  threadsStore,
  upsertThread,
} from "@stores/threads.store";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import { createMockWsClient } from "../helpers/mock-ws";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";
import { makeThread } from "../helpers/thread-fixtures";

const PARENT = 1;
const THREAD = 91;

let ws: ReturnType<typeof createMockWsClient>;
let container: HTMLDivElement;
const toast = vi.fn();
let disposers: (() => void)[] = [];
const loadMessages = vi.fn(async () => {});
const msgCtrl = {
  loadMessages,
  loadOlderMessages: vi.fn(async () => {}),
  loadNewerMessages: vi.fn(async () => {}),
};
const api = {
  getConfig: () => ({ host: "h" }),
  getMessagesAround: vi.fn(async () => ({ messages: [] })),
  pinMessage: vi.fn(async () => {}),
  unpinMessage: vi.fn(async () => {}),
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
} as unknown as ApiClient;
const reactions = { handleReaction: vi.fn(), destroy: vi.fn() };
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function seedMessages(channel: number, messages: Message[]): void {
  messagesStore.setState((prev) => ({
    ...prev,
    messagesByChannel: new Map(prev.messagesByChannel).set(channel, messages),
  }));
}

function mountPanel() {
  const panel = createThreadPanel({
    ws: ws as unknown as WsClient,
    api,
    msgCtrl,
    threadId: THREAD,
    reactions,
    showToast: toast,
    onClose: vi.fn(),
  });
  panel.mount(container);
  disposers.push(() => panel.destroy?.());
  return panel;
}

const q = <T extends HTMLElement>(sel: string): T => container.querySelector<T>(sel) as T;
const textarea = (): HTMLTextAreaElement => q<HTMLTextAreaElement>("textarea");

beforeEach(() => {
  resetGateStores();
  resetMessagesStore();
  resetThreadsStore();
  signInAs("member");
  setChannel();
  applyReadyCapabilities({ threads: true });
  ws = createMockWsClient();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  upsertThread(makeThread({ id: THREAD, parent_id: PARENT, starter_message_id: 1, owner_id: ME }));
  seedMessages(PARENT, [
    makeMessage({
      id: 1,
      channelId: PARENT,
      content: "the starter",
      user: { id: OTHER, username: "alice", avatar: null },
    }),
  ]);
  seedMessages(THREAD, [
    makeMessage({ id: 100, channelId: THREAD, content: "first reply" }),
    makeMessage({ id: 101, channelId: THREAD, content: "second reply" }),
  ]);
  noteSeen.mockClear();
  loadMessages.mockClear();
  toast.mockClear();
});
afterEach(() => {
  for (const d of disposers.splice(0)) d();
  container.remove();
  document.body.replaceChildren();
  resetServerCapabilities();
  resetThreadsStore();
  resetMessagesStore();
  resetGateStores();
  vi.restoreAllMocks();
});

describe("ThreadPanel", () => {
  it("shows the starter on top and the thread's own messages in a second list", async () => {
    const panel = mountPanel();
    await flush();
    expect(q('[data-testid="thread-starter"]').textContent).toContain("the starter");
    const list = q('[data-testid="thread-panel-messages"]');
    expect(list.querySelector('[data-testid="message-100"]')?.textContent).toContain("first reply");
    expect(list.querySelector('[data-testid="message-101"]')).not.toBeNull();
    expect(loadMessages).toHaveBeenCalledWith(THREAD, expect.any(AbortSignal));
    panel.destroy?.();
  });

  it("has a one-line text-only composer: short placeholder, no attach button", async () => {
    const panel = mountPanel();
    await flush();
    expect(textarea().placeholder).toBe("Reply in thread");
    expect(container.querySelector(".attach-btn")).toBeNull();
    panel.destroy?.();
  });

  it("mounts beside a channel's own list without either touching the other", async () => {
    const channelBox = document.createElement("div");
    document.body.appendChild(channelBox);
    seedMessages(PARENT, [
      makeMessage({
        id: 1,
        channelId: PARENT,
        content: "the starter",
        user: { id: OTHER, username: "alice", avatar: null },
      }),
      makeMessage({
        id: 2,
        channelId: PARENT,
        content: "channel talk",
        user: { id: OTHER, username: "alice", avatar: null },
      }),
    ]);
    const channelList = createMessageList(makeOpts({ channelId: PARENT }));
    channelList.mount(channelBox);
    const panel = mountPanel();
    await flush();
    expect(channelBox.querySelector('[data-testid="message-2"]')).not.toBeNull();
    expect(channelBox.querySelector('[data-testid="message-100"]')).toBeNull();
    expect(
      q('[data-testid="thread-panel-messages"]').querySelector('[data-testid="message-2"]'),
    ).toBeNull();
    panel.destroy?.();
    expect(channelBox.querySelector('[data-testid="message-2"]')).not.toBeNull();
    channelList.destroy?.();
  });

  it("says the original message was deleted when its pointer is gone", () => {
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, starter_message_id: null }));
    mountPanel();
    expect(q('[data-testid="thread-starter"]').textContent).toContain("deleted");
  });

  it("sends text into the thread, optimistically", async () => {
    setConnectionStatus("connected");
    mountPanel();
    await flush();
    textarea().value = "hello thread";
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const sent = ws.getSentMessages() as unknown as {
      type: string;
      payload: Record<string, unknown>;
    }[];
    const send = sent.find((m) => m.type === "chat_send");
    expect(send?.payload).toMatchObject({
      channel_id: THREAD,
      content: "hello thread",
      reply_to: null,
    });
    expect(
      (messagesStore.getState().messagesByChannel.get(THREAD) ?? []).some(
        (m) => m.content === "hello thread" && m.status === "pending",
      ),
    ).toBe(true);
  });
});

describe("stickers in a thread (WP 8.8)", () => {
  const SET = [{ id: 7, name: "Wave", emoji: null, url: "/api/v1/stickers/7/image" }];

  async function pickSticker(): Promise<void> {
    setStickers(SET);
    stickersStore.flush();
    mountPanel();
    await flush();
    q<HTMLButtonElement>(".sticker-btn").click();
    await vi.dynamicImportSettled();
    q<HTMLElement>('.sp-item[data-sticker-id="7"]').click();
  }
  const sentSends = (): { payload: Record<string, unknown> }[] =>
    (
      ws.getSentMessages() as unknown as { type: string; payload: Record<string, unknown> }[]
    ).filter((m) => m.type === "chat_send");

  beforeEach(() => {
    applyReadyCapabilities({ threads: true, stickers: true });
    setConnectionStatus("connected");
  });
  afterEach(() => {
    clearStickers();
    stickersStore.flush();
  });

  it("has a sticker button only on a server with stickers", async () => {
    applyReadyCapabilities({ threads: true });
    mountPanel();
    await flush();
    expect(container.querySelector(".sticker-btn")).toBeNull();
  });

  it("sends the picked sticker into the thread as sticker_id, optimistically", async () => {
    await pickSticker();
    const sends = sentSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.payload).toMatchObject({
      channel_id: THREAD,
      content: "",
      sticker_id: 7,
      reply_to: null,
    });
    expect(typeof sends[0]!.payload["client_message_id"]).toBe("string");
    const row = (messagesStore.getState().messagesByChannel.get(THREAD) ?? []).find(
      (m) => m.sticker?.id === 7,
    );
    expect(row?.status).toBe("pending");
    expect(row?.content).toBe("[Sticker: Wave]");
  });
});

describe("read marking for the focused thread", () => {
  function mountThreadList(): ReturnType<typeof createMessageList> {
    const list = createMessageList(makeOpts({ channelId: THREAD, channelType: "thread" }));
    list.mount(container);
    return list;
  }

  it("counts the thread as seen only while the panel has it focused", async () => {
    applyReadyCapabilities({ threads: true, read_pointer: true });
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: PARENT }));
    const list = mountThreadList();
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(noteSeen.mock.calls.some(([id]) => id === THREAD)).toBe(false);

    setFocusedThread(THREAD);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(noteSeen.mock.calls.some(([id]) => id === THREAD)).toBe(true);
    list.destroy?.();
  });
});

describe("a locked or archived thread", () => {
  it("disables the composer for a member, with the reason", () => {
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, locked: true }));
    mountPanel();
    expect(textarea().disabled || textarea().readOnly).toBe(true);
    expect(textarea().placeholder).toContain("Thread locked");
    expect(q('[data-testid="thread-panel-status"]').textContent).toContain("Locked");
  });

  it("leaves it open for a moderator, who also gets lock and delete", () => {
    signInAs("moderator");
    setChannel({ canDeleteOthers: true });
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, locked: true }));
    mountPanel();
    expect(textarea().disabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-testid="thread-lock"]').hidden).toBe(false);
    expect(q<HTMLButtonElement>('[data-testid="thread-delete"]').hidden).toBe(false);
  });

  it("hides lock and delete from the owner, who may still rename and archive", () => {
    mountPanel();
    expect(q<HTMLButtonElement>('[data-testid="thread-lock"]').hidden).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="thread-delete"]').hidden).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="thread-rename"]').hidden).toBe(false);
    expect(q<HTMLButtonElement>('[data-testid="thread-archive"]').hidden).toBe(false);
  });

  it("hides rename and archive from someone else's thread", () => {
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, owner_id: OTHER }));
    mountPanel();
    expect(q<HTMLButtonElement>('[data-testid="thread-rename"]').hidden).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="thread-archive"]').hidden).toBe(true);
  });

  it("says an archived thread reopens on send, and still lets the user type", () => {
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, archived: true }));
    mountPanel();
    expect(textarea().disabled).toBe(false);
    expect(container.textContent).toContain("Sending reopens it");
    expect(q('[data-testid="thread-panel-status"]').textContent).toContain("Archived");
  });

  it("follows a thread_changed that locks it", async () => {
    mountPanel();
    expect(textarea().disabled).toBe(false);
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, locked: true, owner_id: ME }));
    await flush();
    expect(textarea().placeholder).toContain("Thread locked");
  });

  it("archives, locks and renames with thread_update, and deletes only after a confirm", async () => {
    signInAs("moderator");
    setChannel({ canDeleteOthers: true });
    setConnectionStatus("connected");
    mountPanel();
    q<HTMLButtonElement>('[data-testid="thread-archive"]').click();
    q<HTMLButtonElement>('[data-testid="thread-lock"]').click();
    q<HTMLButtonElement>('[data-testid="thread-rename"]').click();
    const input = q<HTMLInputElement>('[data-testid="thread-rename-input"]');
    input.value = "  Better name ";
    input.form!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const sent = ws.getSentMessages() as unknown as { type: string; payload: unknown }[];
    expect(sent.filter((m) => m.type === "thread_update").map((m) => m.payload)).toEqual([
      { thread_id: THREAD, archived: true },
      { thread_id: THREAD, locked: true },
      { thread_id: THREAD, name: "Better name" },
    ]);

    q<HTMLButtonElement>('[data-testid="thread-delete"]').click();
    expect(sent.some((m) => m.type === "thread_delete")).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-testid="thread-delete-confirm"]')!.click();
    expect(sent.find((m) => m.type === "thread_delete")?.payload).toEqual({ thread_id: THREAD });
  });
});

describe("ThreadPanelHost", () => {
  async function makeHost() {
    const slot = document.createElement("div");
    const app = document.createElement("div");
    app.appendChild(slot);
    document.body.appendChild(app);
    const host = createThreadPanelHost({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl: msgCtrl as never,
      slot,
      showToast: toast,
    });
    disposers.push(() => host.destroy());
    return { host, slot, app };
  }
  const focusFrames = () =>
    (ws.getSentMessages() as unknown as { type: string; payload: unknown }[]).filter(
      (m) => m.type === "thread_focus",
    );

  it("re-sends thread_focus for its open thread when the dispatcher resumes, until destroyed", async () => {
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    expect(focusFrames()).toHaveLength(1);
    resumeThreadFocus(ws as unknown as WsClient, undefined);
    expect(focusFrames().map((m) => m.payload)).toEqual([
      { thread_id: THREAD },
      { thread_id: THREAD },
    ]);
    host.destroy();
    resumeThreadFocus(ws as unknown as WsClient, undefined);
    expect(
      focusFrames().filter((m) => (m.payload as { thread_id: number | null }).thread_id === THREAD),
    ).toHaveLength(2);
  });

  it("opens the panel and sends thread_focus, then closes with null", async () => {
    const { host, slot, app } = await makeHost();
    host.open(getThread(THREAD)!);
    expect(threadsStore.getState().focusedThreadId).toBe(THREAD);
    expect(focusFrames().map((m) => m.payload)).toEqual([{ thread_id: THREAD }]);
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    expect(app.classList.contains("thread-open")).toBe(true);

    host.close();
    expect(threadsStore.getState().focusedThreadId).toBeNull();
    expect(focusFrames().map((m) => m.payload)).toEqual([
      { thread_id: THREAD },
      { thread_id: null },
    ]);
    expect(slot.children.length).toBe(0);
    expect(app.classList.contains("thread-open")).toBe(false);
  });

  it("drops a panel whose code finishes loading after it was closed", async () => {
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    host.close();
    await flush();
    await flush();
    expect(slot.children.length).toBe(0);
  });

  it("opening the open thread again only refocuses it", async () => {
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    host.open(getThread(THREAD)!);
    expect(focusFrames()).toHaveLength(1);
    host.close();
  });

  it("takes the panel down when the thread is deleted under it, with no frame of its own", async () => {
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    const { removeThread } = await import("@stores/threads.store");
    removeThread(THREAD);
    await flush();
    expect(slot.children.length).toBe(0);
    expect(host.openThreadId).toBeNull();
    expect(focusFrames()).toHaveLength(1);
  });

  it("puts a width handle on the open panel; a key step is saved and kept on the next open", async () => {
    localStorage.removeItem("owncord:settings:threadPanelWidth");
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    const handle = slot.querySelector<HTMLElement>('[data-testid="thread-panel-resize"]');
    expect(handle?.getAttribute("role")).toBe("separator");
    expect(handle?.getAttribute("aria-label")).toBe("Resize thread panel");
    expect(slot.style.getPropertyValue("--thread-panel-width")).toBe("380px");

    handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(slot.style.getPropertyValue("--thread-panel-width")).toBe("396px");
    expect(localStorage.getItem("owncord:settings:threadPanelWidth")).toBe("396");

    host.close();
    expect(slot.querySelector('[data-testid="thread-panel-resize"]')).toBeNull();
    host.open(getThread(THREAD)!);
    expect(slot.querySelector('[data-testid="thread-panel-resize"]')).not.toBeNull();
    expect(slot.style.getPropertyValue("--thread-panel-width")).toBe("396px");
    host.close();
  });

  it("switching to another thread closes the first and focuses the second", async () => {
    upsertThread(makeThread({ id: 92, parent_id: PARENT, starter_message_id: 2 }));
    const { host, slot } = await makeHost();
    host.open(getThread(THREAD)!);
    host.open(getThread(92)!);
    await vi.waitFor(() =>
      expect(slot.querySelectorAll('[data-testid="thread-panel"]').length).toBe(1),
    );
    expect(slot.querySelector('[data-thread-id="92"]')).not.toBeNull();
    expect(focusFrames().map((m) => m.payload)).toEqual([{ thread_id: THREAD }, { thread_id: 92 }]);
    host.close();
  });
});

void authStore;

describe("ThreadPanelHost review fixes", () => {
  async function host() {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const h = createThreadPanelHost({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl: msgCtrl as never,
      slot,
      showToast: toast,
    });
    disposers.push(() => h.destroy());
    return { h, slot };
  }
  const frames = (type: string) =>
    (ws.getSentMessages() as unknown as { type: string; payload: unknown }[]).filter(
      (m) => m.type === type,
    );

  it("reloads a thread's history after it was closed (its frames stopped while closed)", async () => {
    const { h, slot } = await host();
    messagesStore.setState((p) => ({
      ...p,
      loadedChannels: new Set(p.loadedChannels).add(THREAD),
    }));
    expect(isChannelLoaded(THREAD)).toBe(true);
    h.open(getThread(THREAD)!);
    await vi.waitFor(() => expect(slot.children.length).toBe(1));
    h.close();
    expect(isChannelLoaded(THREAD)).toBe(false);
  });

  it("keeps what a live frame set when a stale snapshot is opened", async () => {
    const { h } = await host();
    upsertThread(makeThread({ id: THREAD, parent_id: PARENT, locked: true }));
    h.open(makeThread({ id: THREAD, parent_id: PARENT, locked: false }));
    expect(getThread(THREAD)?.locked).toBe(true);
  });

  it("does not open a thread that was deleted", async () => {
    const { h } = await host();
    removeThread(THREAD);
    h.open(makeThread({ id: THREAD, parent_id: PARENT }));
    expect(h.openThreadId).toBeNull();
    expect(frames("thread_focus")).toHaveLength(0);
  });

  it("opens by id from the store, behind a frame the dispatcher is still writing", async () => {
    const { h } = await host();
    const fresh = makeThread({ id: 120, parent_id: PARENT, starter_message_id: 77 });
    withThreadsStore((m) => m.upsertThread(fresh));
    h.openById(120, PARENT, new AbortController().signal);
    await vi.waitFor(() => expect(h.openThreadId).toBe(120));
    expect((api as unknown as { listThreads?: unknown }).listThreads).toBeUndefined();
  });

  it("says thread_focus again when the user's timeout clears", async () => {
    const { h } = await host();
    h.open(getThread(THREAD)!);
    safetyStore.setState((p) => ({ ...p, timeout: { expiresAt: "2099-01-01T00:00:00Z" } }));
    await flush();
    expect(frames("thread_focus")).toHaveLength(1);
    safetyStore.setState((p) => ({ ...p, timeout: null }));
    await vi.waitFor(() => expect(frames("thread_focus")).toHaveLength(2));
  });

  it("says thread_focus again when the parent's permissions change", async () => {
    const { h } = await host();
    h.open(getThread(THREAD)!);
    expect(frames("thread_focus")).toHaveLength(1);
    setChannel({ canSend: false });
    await vi.waitFor(() => expect(frames("thread_focus")).toHaveLength(2));
    // An unrelated channel change (an unread badge) is not a permission change.
    channelsStore.setState((p) => ({
      ...p,
      channels: new Map(p.channels).set(PARENT, { ...p.channels.get(PARENT)!, unreadCount: 3 }),
    }));
    expect(frames("thread_focus")).toHaveLength(2);
  });
});

describe("a thread created after its starter row rendered", () => {
  it("gets its chip live, and loses it on delete", async () => {
    resetThreadsStore();
    seedMessages(PARENT, [
      makeMessage({
        id: 7,
        channelId: PARENT,
        content: "no thread yet",
        user: { id: OTHER, username: "alice", avatar: null },
      }),
    ]);
    const box = document.createElement("div");
    document.body.appendChild(box);
    const list = createMessageList(makeOpts({ channelId: PARENT, onOpenThread: vi.fn() }));
    disposers.push(() => {
      list.destroy?.();
      box.remove();
    });
    list.mount(box);
    const chipText = (): string | undefined =>
      box.querySelector('[data-testid="message-7"] .msg-thread-chip')?.textContent ?? undefined;
    await vi.waitFor(() => expect(box.querySelector('[data-testid="message-7"]')).not.toBeNull());
    expect(chipText()).toBeUndefined();
    upsertThread(makeThread({ id: 130, parent_id: PARENT, starter_message_id: 7, name: "Fresh" }));
    await vi.waitFor(() => expect(chipText()).toContain("Fresh"));
    removeThread(130);
    await vi.waitFor(() => expect(chipText()).toBeUndefined());
    // Recreated under a new id: a chip again.
    upsertThread(makeThread({ id: 131, parent_id: PARENT, starter_message_id: 7, name: "Again" }));
    await vi.waitFor(() => expect(chipText()).toContain("Again"));
  });
});

describe("a forum post in the panel (WP 6.9d)", () => {
  const POST = 95;
  const TAGGED = {
    tag_ids: [2],
    first_message: {
      id: 950,
      author_id: ME,
      preview: "hi",
      has_attachments: false,
      deleted: false,
    },
  };

  beforeEach(() => {
    setChannel({
      type: "forum",
      canSend: true,
      forum: {
        tags: [
          { id: 1, name: "Bug", position: 0 },
          { id: 2, name: "Idea", emoji: "💡", position: 1 },
        ],
        require_tag: false,
        default_auto_archive_minutes: 4320,
      },
    });
    upsertThread(
      makeThread({
        id: POST,
        parent_id: PARENT,
        starter_message_id: null,
        owner_id: ME,
        post: TAGGED,
      }),
    );
    seedMessages(POST, [makeMessage({ id: 950, channelId: POST, content: "the opening message" })]);
  });

  function mountPost() {
    const panel = createThreadPanel({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl,
      threadId: POST,
      reactions,
      showToast: toast,
      onClose: vi.fn(),
    });
    panel.mount(container);
    disposers.push(() => panel.destroy?.());
    return panel;
  }

  it("has no starter to state: the opening message is the first one in the list", () => {
    mountPost();
    const starter = q<HTMLElement>('[data-testid="thread-starter"]');
    expect(starter.hidden).toBe(true);
    expect(starter.textContent).toBe("");
    expect(q('[data-testid="thread-panel-messages"]').textContent).toContain("the opening message");
  });

  it("shows the post's tags under its title", () => {
    mountPost();
    const tags = q<HTMLElement>('[data-testid="thread-panel-tags"]');
    expect(tags.hidden).toBe(false);
    expect(Array.from(tags.querySelectorAll(".forum-tag")).map((t) => t.textContent)).toEqual([
      "💡 Idea",
    ]);
    expect(q('[data-testid="thread-panel"]').textContent).toContain("in #general");
  });

  it("still states a missing starter for an ordinary thread", () => {
    upsertThread(makeThread({ id: 96, parent_id: PARENT, starter_message_id: null }));
    const panel = createThreadPanel({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl,
      threadId: 96,
      reactions,
      showToast: toast,
      onClose: vi.fn(),
    });
    panel.mount(container);
    disposers.push(() => panel.destroy?.());
    expect(q<HTMLElement>('[data-testid="thread-starter"]').hidden).toBe(false);
    expect(q('[data-testid="thread-starter"]').textContent).toContain(
      "original message was deleted",
    );
  });

  it("hands focus back to the list row when the panel's Close is pressed", async () => {
    const slot = document.createElement("div");
    const list = document.createElement("div");
    const row = document.createElement("button");
    row.dataset["postId"] = String(POST);
    list.appendChild(row);
    document.body.append(list, slot);
    const host = createThreadPanelHost({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl: msgCtrl as never,
      slot,
      showToast: toast,
    });
    disposers.push(() => host.destroy());
    const signal = new AbortController().signal;
    host.openById(POST, PARENT, signal, () =>
      list.querySelector<HTMLElement>(`[data-post-id="${POST}"]`),
    );
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    slot.querySelector<HTMLButtonElement>('[data-testid="thread-close"]')!.focus();
    slot.querySelector<HTMLButtonElement>('[data-testid="thread-close"]')!.click();
    expect(host.openThreadId).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("does not move focus when the panel is closed by the page (a channel switch)", async () => {
    const slot = document.createElement("div");
    const row = document.createElement("button");
    document.body.append(row, slot);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    const host = createThreadPanelHost({
      ws: ws as unknown as WsClient,
      api,
      msgCtrl: msgCtrl as never,
      slot,
      showToast: toast,
    });
    disposers.push(() => host.destroy());
    host.open(getThread(POST)!, () => row);
    await vi.waitFor(() =>
      expect(slot.querySelector('[data-testid="thread-panel"]')).not.toBeNull(),
    );
    elsewhere.focus();
    host.close();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("ThreadPanel follow toggle (WP 6.9c-c2)", () => {
  const follow = (): HTMLButtonElement => q<HTMLButtonElement>('[data-testid="thread-follow"]');

  it("is hidden when the server has no thread_follows capability", () => {
    mountPanel();
    expect(follow().hidden).toBe(true);
  });

  it("shows Follow and sends thread_follow true", () => {
    applyReadyCapabilities({ threads: true, thread_follows: true });
    setConnectionStatus("connected");
    mountPanel();
    expect(follow().hidden).toBe(false);
    expect(follow().textContent).toBe("Follow");
    expect(follow().getAttribute("aria-pressed")).toBe("false");
    follow().click();
    expect(ws.lastSent).toMatchObject({
      type: "thread_follow",
      payload: { thread_id: THREAD, follow: true },
    });
  });

  it("shows Following once followed and sends thread_follow false", () => {
    applyReadyCapabilities({ threads: true, thread_follows: true });
    setConnectionStatus("connected");
    applyFollowUpdate(THREAD, true, makeThread({ id: THREAD, parent_id: PARENT }));
    mountPanel();
    expect(follow().textContent).toBe("Following");
    expect(follow().getAttribute("aria-pressed")).toBe("true");
    follow().click();
    expect(ws.lastSent).toMatchObject({
      type: "thread_follow",
      payload: { thread_id: THREAD, follow: false },
    });
  });

  it("repaints when the follow state changes under it", async () => {
    applyReadyCapabilities({ threads: true, thread_follows: true });
    mountPanel();
    expect(follow().textContent).toBe("Follow");
    applyFollowUpdate(THREAD, true, makeThread({ id: THREAD, parent_id: PARENT }));
    await vi.waitFor(() => expect(follow().textContent).toBe("Following"));
  });

  it("toasts and sends nothing when the socket is down", () => {
    applyReadyCapabilities({ threads: true, thread_follows: true });
    setConnectionStatus("disconnected");
    mountPanel();
    follow().click();
    expect(ws.getSentMessages().some((m) => m.type === "thread_follow")).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });
});
