/**
 * Following a thread through the dispatcher (WP 6.9c-c2): ready.threads,
 * thread_follow_update / _ok, and channel_activity, mention_count and
 * read_state for a followed thread id versus one nobody follows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireDispatcher } from "../../src/lib/dispatcher";
import { createMockWsClient } from "../helpers/mock-ws";
import { makeThread } from "../helpers/thread-fixtures";
import { channelsStore, resetChannelsStore, setChannels } from "../../src/stores/channels.store";
import { isFollowed, resetThreadsStore, threadsStore } from "../../src/stores/threads.store";
import { followedThreadsStore } from "../../src/stores/followedThreads.store";
import { resetChannelActivity } from "../../src/features/channels/wsHandlers";
import { resetServerCapabilities } from "../../src/lib/net/serverCapabilities";
import type { WsClient } from "../../src/lib/ws";
import type { ReadyChannel, ReadyPayload, ReadyThread } from "../../src/lib/types";

const notifyMention = vi.hoisted(() => vi.fn());
const notifyChannelActivity = vi.hoisted(() => vi.fn());
vi.mock("@lib/notifications", () => ({
  notifyIncomingMessage: vi.fn(),
  notifyMention,
  notifyChannelActivity,
  cleanupNotificationAudio: vi.fn(),
}));
vi.mock("@lib/toast", () => ({ showToast: vi.fn() }));

const PARENT = 4;
const THREAD = 91;
const STRANGER = 777;

function parent(): ReadyChannel {
  return { id: PARENT, name: "general", type: "text", category: null, position: 1 };
}

function readyThread(over: Partial<ReadyThread> = {}): ReadyThread {
  return {
    thread: makeThread({ id: THREAD, parent_id: PARENT, name: "Release plan" }),
    last_message_id: 100,
    last_read_message_id: 100,
    unread_count: 0,
    mention_count: 0,
    ...over,
  };
}

function ready(threads?: readonly ReadyThread[]): ReadyPayload {
  return {
    capabilities: { threads: true, thread_follows: true },
    channels: [parent()],
    members: [],
    voice_states: [],
    roles: [],
    dm_channels: [],
    ...(threads !== undefined ? { threads } : {}),
  };
}

let mock: ReturnType<typeof createMockWsClient>;
let cleanup: () => void;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const activity = (channel_id: number, message_id: number, mentions_you = false) => ({
  channels: [{ channel_id, message_id, mentions_you, mentions_everyone: false }],
});
const followed = () => threadsStore.getState().followed.get(THREAD);

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(console, "info").mockImplementation(() => {});
  mock = createMockWsClient();
  resetThreadsStore();
  resetChannelsStore();
  resetChannelActivity();
  notifyMention.mockClear();
  notifyChannelActivity.mockClear();
  cleanup = wireDispatcher(
    mock as unknown as WsClient,
    {
      listBlocks: vi.fn(async () => ({ blocked: [] })),
    } as never,
  );
});
afterEach(() => {
  cleanup();
  resetThreadsStore();
  resetChannelsStore();
  resetServerCapabilities();
  vi.restoreAllMocks();
});

describe("ready.threads", () => {
  it("fills the follow map and the sidebar rows", async () => {
    mock.simulateMessage("ready", ready([readyThread({ unread_count: 2, mention_count: 1 })]));
    await flush();
    expect(followed()).toMatchObject({ unread: 2, mentions: 1 });
    expect(followedThreadsStore.getState().byParent.get(PARENT)?.[0]).toMatchObject({
      id: THREAD,
      name: "Release plan",
      unread: 2,
      mentions: 1,
    });
  });

  it("a later ready without the thread drops it (the parent was unreadable)", async () => {
    mock.simulateMessage("ready", ready([readyThread()]));
    await flush();
    mock.simulateMessage("ready", ready([]));
    await flush();
    expect(isFollowed(THREAD)).toBe(false);
    mock.simulateMessage("ready", ready([readyThread()]));
    await flush();
    expect(isFollowed(THREAD)).toBe(true);
  });
});

describe("thread_follow_update", () => {
  it("follows with the frame's thread, then unfollows on another device's unfollow", async () => {
    setChannels([parent()]);
    mock.simulateMessage("thread_follow_update", {
      thread_id: THREAD,
      following: true,
      thread: makeThread({ id: THREAD, parent_id: PARENT }),
    });
    await flush();
    expect(isFollowed(THREAD)).toBe(true);
    mock.simulateMessage("thread_follow_update", { thread_id: THREAD, following: false });
    await flush();
    expect(isFollowed(THREAD)).toBe(false);
    expect(followedThreadsStore.getState().byParent.size).toBe(0);
  });

  it("a late following:true after thread_deleted does not resurrect the row", async () => {
    mock.simulateMessage("ready", ready([readyThread()]));
    await flush();
    mock.simulateMessage("thread_deleted", { channel_id: PARENT, thread_id: THREAD });
    mock.simulateMessage("thread_follow_update", {
      thread_id: THREAD,
      following: true,
      thread: makeThread({ id: THREAD, parent_id: PARENT }),
    });
    await flush();
    expect(isFollowed(THREAD)).toBe(false);
    expect(followedThreadsStore.getState().byParent.size).toBe(0);
  });

  it("thread_follow_ok states the follow too", async () => {
    mock.simulateMessage("thread_changed", {
      thread: makeThread({ id: THREAD, parent_id: PARENT }),
    });
    await flush();
    mock.simulateMessage("thread_follow_ok", { thread_id: THREAD, following: true });
    await flush();
    expect(isFollowed(THREAD)).toBe(true);
  });
});

describe("channel_activity and mention_count for a thread id", () => {
  beforeEach(async () => {
    mock.simulateMessage("ready", ready([readyThread()]));
    await flush();
  });

  it("counts a followed thread's hint and alerts as the thread", async () => {
    mock.simulateMessage("channel_activity", activity(THREAD, 101));
    await flush();
    expect(followed()?.unread).toBe(1);
    expect(notifyChannelActivity).toHaveBeenCalledTimes(1);
    expect(notifyChannelActivity.mock.calls[0]?.[1]).toMatchObject({
      parentId: PARENT,
      name: "Release plan",
      watching: false,
    });
    // The parent channel itself is untouched.
    expect(channelsStore.getState().channels.get(PARENT)?.unreadCount).toBe(0);
  });

  it("ignores an id nobody follows and does not alert", async () => {
    mock.simulateMessage("channel_activity", activity(STRANGER, 5, true));
    mock.simulateMessage("mention_count", { channel_id: STRANGER, count: 3 });
    await flush();
    expect(followed()?.unread).toBe(0);
    expect(threadsStore.getState().followed.size).toBe(1);
    expect(notifyChannelActivity).not.toHaveBeenCalled();
    expect(notifyMention).not.toHaveBeenCalled();
  });

  it("does not count a hint for a thread the panel has open", async () => {
    const { setFocusedThread } = await import("../../src/stores/threads.store");
    setFocusedThread(THREAD);
    mock.simulateMessage("channel_activity", activity(THREAD, 101));
    await flush();
    expect(followed()?.unread).toBe(0);
    expect(notifyChannelActivity).not.toHaveBeenCalled();
  });

  it("repaints a followed thread's mention badge from the total", async () => {
    mock.simulateMessage("mention_count", { channel_id: THREAD, count: 2 });
    await flush();
    expect(followed()?.mentions).toBe(2);
    expect(followedThreadsStore.getState().byParent.get(PARENT)?.[0]?.mentions).toBe(2);
    mock.simulateMessage("mention_count", { channel_id: THREAD, count: 0 });
    await flush();
    expect(followed()?.mentions).toBe(0);
  });

  it("follows a read_state for the thread", async () => {
    mock.simulateMessage("channel_activity", activity(THREAD, 101));
    await flush();
    mock.simulateMessage("read_state", {
      channel_id: THREAD,
      last_read_message_id: 101,
      unread_count: 0,
      mention_count: 0,
    });
    await flush();
    expect(followed()).toMatchObject({ unread: 0, mentions: 0, lastReadId: 101 });
  });
});

describe("a session that never met a thread", () => {
  it("does not load the thread store for an activity hint", async () => {
    mock.simulateMessage("channel_activity", activity(STRANGER, 5));
    mock.simulateMessage("mention_count", { channel_id: STRANGER, count: 1 });
    await flush();
    expect(threadsStore.getState().followed.size).toBe(0);
    expect(notifyChannelActivity).not.toHaveBeenCalled();
  });
});
