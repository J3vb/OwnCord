import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore } from "../../stores/channels.store";
import { dmStore } from "../../stores/dm.store";
import { makeChannel } from "../../../tests/helpers/channelFactory";
import { makeDm, dmRecipient } from "../../../tests/helpers/dmHarness";
import { startNotificationClearing } from "./clearOnRead";

function seed(unread: Record<number, number>, active: number | null): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map(
      Object.entries(unread).map(([id, count]) => [
        Number(id),
        makeChannel({ id: Number(id), name: `ch${id}`, unreadCount: count }),
      ]),
    ),
    activeChannelId: active,
  }));
  channelsStore.flush();
}

function setUnread(id: number, unreadCount: number, mentionCount = 0): void {
  channelsStore.setState((prev) => {
    const channels = new Map(prev.channels);
    const ch = channels.get(id)!;
    channels.set(id, { ...ch, unreadCount, mentionCount });
    return { ...prev, channels };
  });
  channelsStore.flush();
}

function setActive(id: number | null): void {
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: id }));
  channelsStore.flush();
}

let visibility: DocumentVisibilityState;
let clearMessages: ReturnType<typeof vi.fn<(channelId?: number) => Promise<void>>>;
let stop: (() => void) | null;

const cleared = (): (number | undefined)[] => clearMessages.mock.calls.map((call) => call[0]);

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  clearMessages = vi.fn<(channelId?: number) => Promise<void>>().mockResolvedValue(undefined);
  dmStore.setState(() => ({ channels: [] }));
  dmStore.flush();
  seed({ 1: 0, 2: 3, 3: 0 }, 1);
  stop = null;
});

afterEach(() => {
  stop?.();
  vi.restoreAllMocks();
});

describe("startNotificationClearing", () => {
  it("withdraws the channel on screen at start", () => {
    stop = startNotificationClearing({ clearMessages });
    expect(cleared()).toEqual([1]);
  });

  it("withdraws a channel once its unread count goes back to zero", () => {
    stop = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    setUnread(2, 1);
    expect(cleared()).toEqual([]);
    setUnread(2, 0);
    expect(cleared()).toEqual([2]);
  });

  it("waits for the mentions too before a channel counts as read", () => {
    stop = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    setUnread(2, 0, 1);
    expect(cleared()).toEqual([]);
    setUnread(2, 0, 0);
    expect(cleared()).toEqual([2]);
  });

  it("withdraws a DM read on another device", () => {
    const bob = dmRecipient(2, "bob");
    dmStore.setState(() => ({
      channels: [makeDm({ channelId: 55, recipient: bob, participants: [bob], unreadCount: 2 })],
    }));
    dmStore.flush();
    stop = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    dmStore.setState((prev) => ({
      channels: prev.channels.map((c) => ({ ...c, unreadCount: 0 })),
    }));
    dmStore.flush();
    expect(cleared()).toEqual([55]);
  });

  it("withdraws a channel opened on screen", () => {
    stop = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    setActive(3);
    expect(cleared()).toEqual([3]);
  });

  it("leaves the shade alone while the app is hidden, and clears on return", () => {
    stop = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    visibility = "hidden";
    setActive(3);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cleared()).toEqual([]);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cleared()).toEqual([3]);
  });

  it("withdraws everything left when stopped, and then nothing more", () => {
    const stopNow = startNotificationClearing({ clearMessages });
    clearMessages.mockClear();
    stopNow();
    expect(cleared()).toEqual([undefined]);
    setUnread(2, 0);
    setActive(3);
    expect(cleared()).toEqual([undefined]);
  });

  it("keeps going when a withdrawal fails", async () => {
    clearMessages.mockRejectedValue(new Error("gone"));
    stop = startNotificationClearing({ clearMessages });
    setActive(3);
    await Promise.resolve();
    expect(cleared()).toEqual([1, 3]);
  });
});
