import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { expectConsole } from "../helpers/console";
import { makeThread } from "../helpers/thread-fixtures";
import {
  getThread,
  resetThreadsStore,
  setFocusedThread,
  threadsStore,
} from "../../src/stores/threads.store";
import {
  getChannelMessages,
  isChannelLoaded,
  resetMessagesStore,
} from "../../src/stores/messages.store";
import { setThreadResume } from "../../src/stores/threadsLoader";
import { resumeThreadFocus } from "../../src/features/messaging/threadResume";
import { claimForwardRequest } from "../../src/features/messaging/forwardRequests";
import { ApiClientError } from "../../src/lib/api";
import type { WsClient } from "../../src/lib/ws";
import type { ChatMessagePayload, MessageResponse } from "../../src/lib/types";

vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  notifyMention: vi.fn(),
  notifyChannelActivity: vi.fn(),
  cleanupNotificationAudio: vi.fn(),
}));
const showToast = vi.hoisted(() => vi.fn());
vi.mock("@lib/ui/toast", () => ({ showToast }));

const USER = { id: 10, username: "me", avatar: null, role: "member" };
const AUTH_OK = { user: USER, server_name: "S", motd: "" };

function row(id: number, channel: number): MessageResponse {
  return {
    id,
    channel_id: channel,
    user: { id: 11, username: "alice", avatar: null },
    content: `m${id}`,
    reply_to: null,
    attachments: [],
    reactions: [],
    pinned: false,
    edited_at: null,
    deleted: false,
    timestamp: "2026-10-21T09:00:00Z",
  } as MessageResponse;
}

let ws: ReturnType<typeof createMockWsClient>;
let cleanup: () => void;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function wire(getMessages?: ReturnType<typeof vi.fn>): void {
  cleanup = wireDispatcher(
    ws as unknown as WsClient,
    {
      listBlocks: vi.fn(async () => ({ blocked: [] })),
      ...(getMessages !== undefined && { getMessages }),
    } as never,
  );
}

beforeEach(() => {
  ws = createMockWsClient();
  resetThreadsStore();
  resetMessagesStore();
});
afterEach(() => {
  cleanup();
  resetThreadsStore();
});

describe("thread frames through the dispatcher", () => {
  beforeEach(() => wire());

  it("thread_create_ok and thread_changed write the thread's whole state", async () => {
    ws.simulateMessage("thread_create_ok", { thread: makeThread() });
    await flush();
    expect(getThread(91)?.message_count).toBe(7);
    ws.simulateMessage("thread_changed", { thread: makeThread({ message_count: 8, name: "New" }) });
    await flush();
    expect(getThread(91)).toMatchObject({ message_count: 8, name: "New" });
  });

  it("thread_deleted removes the thread and a late thread_changed cannot bring it back", async () => {
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    setFocusedThread(91);
    ws.simulateMessage("thread_deleted", { channel_id: 1, thread_id: 91 });
    ws.simulateMessage("thread_changed", { thread: makeThread({ message_count: 9 }) });
    await flush();
    expect(getThread(91)).toBeUndefined();
    expect(threadsStore.getState().focusedThreadId).toBeNull();
  });

  it("a chat_message that carries a starter's thread records it", async () => {
    const payload: ChatMessagePayload = {
      id: 1,
      channel_id: 1,
      user: { id: 11, username: "alice", avatar: null },
      content: "start",
      reply_to: null,
      attachments: [],
      timestamp: "2026-10-21T09:00:00Z",
      thread: makeThread(),
    };
    ws.simulateMessage("chat_message", payload);
    await flush();
    expect(getThread(91)).toBeDefined();
    expect(getChannelMessages(1)[0]?.thread?.id).toBe(91);
  });

  it("judges a reply in a watched thread by its parent channel for notifications", async () => {
    const { notifyIncomingMessage } = await import("@lib/notifications");
    const notify = vi.mocked(notifyIncomingMessage);
    notify.mockClear();
    ws.simulateMessage("thread_changed", { thread: makeThread({ id: 91, parent_id: 4 }) });
    await vi.waitFor(() => expect(getThread(91)).toBeDefined());
    // Let the loader settle so the store counts as loaded for the handler.
    await flush();
    ws.simulateMessage("chat_message", {
      id: 500,
      channel_id: 91,
      user: { id: 11, username: "alice", avatar: null },
      content: "reply",
      reply_to: null,
      attachments: [],
      timestamp: new Date().toISOString(),
    } as ChatMessagePayload);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].channel_id).toBe(4);
  });

  it("never lists a thread in the channel store", async () => {
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    await flush();
    const { channelsStore } = await import("../../src/stores/channels.store");
    expect(channelsStore.getState().channels.has(91)).toBe(false);
  });

  it("skips the generic error toast for a claimed thread_create", () => {
    claimForwardRequest("req-1");
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" }, "req-1");
    expect(showToast).not.toHaveBeenCalled();
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" }, "req-2");
    expectConsole("error", /Server error/);
    expectConsole("error", /Server error/);
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

describe("a panel open across a reconnect", () => {
  // The panel's host registers the resume hook while it is mounted.
  beforeEach(() => setThreadResume(resumeThreadFocus));
  afterEach(() => setThreadResume(null));

  it("says thread_focus again and refetches the thread's history", async () => {
    const getMessages = vi.fn(async () => ({
      messages: [row(5, 91), row(4, 91)],
      has_more: false,
    }));
    wire(getMessages);
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    setFocusedThread(91);

    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(isChannelLoaded(91)).toBe(true));

    expect(ws.getSentMessages()).toContainEqual(
      expect.objectContaining({ type: "thread_focus", payload: { thread_id: 91 } }),
    );
    expect(getMessages).toHaveBeenCalledWith(91, { limit: 50 });
    expect(getChannelMessages(91).map((m) => m.id)).toEqual([4, 5]);
    expect(isChannelLoaded(91)).toBe(true);
  });

  it("sends nothing and fetches nothing with no panel open", async () => {
    const getMessages = vi.fn();
    wire(getMessages);
    ws.simulateMessage("auth_ok", AUTH_OK);
    await flush();
    expect(ws.getSentMessages().some((m) => (m as { type: string }).type === "thread_focus")).toBe(
      false,
    );
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("drops a refetch that a later reconnect or a closed panel supersedes", async () => {
    let release!: (v: { messages: MessageResponse[]; has_more: boolean }) => void;
    const getMessages = vi.fn(
      () => new Promise<{ messages: MessageResponse[]; has_more: boolean }>((r) => (release = r)),
    );
    wire(getMessages);
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    // Closed while the answer is in flight: the answer is dropped.
    setFocusedThread(91);
    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(1));
    setFocusedThread(null);
    release({ messages: [row(5, 91)], has_more: false });
    await flush();
    expect(getChannelMessages(91)).toEqual([]);

    // A second reconnect supersedes the first attempt's answer.
    setFocusedThread(91);
    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
    const first = release;
    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledTimes(3));
    first({ messages: [row(7, 91)], has_more: false });
    await flush();
    expect(getChannelMessages(91)).toEqual([]);
    release({ messages: [row(8, 91)], has_more: false });
    await vi.waitFor(() => expect(getChannelMessages(91).map((m) => m.id)).toEqual([8]));
  });

  it("closes the panel when the thread is gone after the reconnect", async () => {
    const getMessages = vi.fn(async () => {
      throw new ApiClientError(404, "NOT_FOUND", "gone");
    });
    wire(getMessages);
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    setFocusedThread(91);
    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(threadsStore.getState().focusedThreadId).toBeNull());
    expect(getThread(91)).toBeUndefined();
  });

  it("closes the panel but keeps the thread when the reconnect finds it unreadable", async () => {
    const getMessages = vi.fn(async () => {
      throw new ApiClientError(403, "FORBIDDEN", "no");
    });
    wire(getMessages);
    ws.simulateMessage("thread_changed", { thread: makeThread() });
    setFocusedThread(91);
    ws.simulateMessage("auth_ok", AUTH_OK);
    await vi.waitFor(() => expect(threadsStore.getState().focusedThreadId).toBeNull());
    expect(getThread(91)).toBeDefined();
  });
});
