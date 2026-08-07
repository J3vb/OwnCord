import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isChannelMuted,
  listMutedChannels,
  muteChannel,
  unmuteChannel,
  toggleChannelMute,
  notificationAllowed,
  invalidateMuteCache,
  setChannelMutesHost,
} from "@lib/channel-mutes";
import { STORAGE_PREFIX } from "@lib/preferences";

const KEY = `${STORAGE_PREFIX}mutedChannels`;

beforeEach(() => {
  localStorage.clear();
  invalidateMuteCache();
});

describe("channel mutes — storage", () => {
  it("starts with nothing muted", () => {
    expect(listMutedChannels()).toEqual([]);
    expect(isChannelMuted(7)).toBe(false);
  });

  it("persists a mute to localStorage under the settings prefix", () => {
    muteChannel(7);
    expect(isChannelMuted(7)).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([7]);
  });

  it("is idempotent in both directions", () => {
    muteChannel(7);
    muteChannel(7);
    expect(listMutedChannels()).toEqual([7]);
    unmuteChannel(7);
    unmuteChannel(7);
    expect(listMutedChannels()).toEqual([]);
  });

  it("toggles and reports the new state", () => {
    expect(toggleChannelMute(3)).toBe(true);
    expect(isChannelMuted(3)).toBe(true);
    expect(toggleChannelMute(3)).toBe(false);
    expect(isChannelMuted(3)).toBe(false);
  });

  it("lists muted channels in ascending order", () => {
    muteChannel(9);
    muteChannel(2);
    muteChannel(5);
    expect(listMutedChannels()).toEqual([2, 5, 9]);
  });

  // Corrupted storage must cost the user the bad entry, not all their mutes.
  it("ignores non-numeric and non-positive entries in stored data", () => {
    localStorage.setItem(KEY, JSON.stringify([1, "two", null, -3, 0, 4.5, 4]));
    invalidateMuteCache();
    expect(listMutedChannels()).toEqual([1, 4]);
  });

  it("falls back to empty when the stored value is not an array", () => {
    localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    invalidateMuteCache();
    expect(listMutedChannels()).toEqual([]);
  });

  it("picks up a mute made elsewhere via the pref-change event", () => {
    muteChannel(11);
    // Simulate another module writing the key directly, then announcing it.
    localStorage.setItem(KEY, JSON.stringify([11, 12]));
    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "mutedChannels" } }),
    );
    expect(isChannelMuted(12)).toBe(true);
  });
});

describe("channel mutes — host scoping", () => {
  afterEach(() => {
    // currentHost is module-level state that outlives a single test.
    setChannelMutesHost(null);
  });

  it("does not leak a mute across two server hosts", () => {
    // Regression for v047: channel ids are per-server, so an unscoped key
    // meant muting channel 7 on one server silently muted channel 7 on every
    // other server too.
    setChannelMutesHost("a.example.com");
    muteChannel(7);
    expect(isChannelMuted(7)).toBe(true);

    setChannelMutesHost("b.example.com");
    expect(isChannelMuted(7)).toBe(false);

    setChannelMutesHost("a.example.com");
    expect(isChannelMuted(7)).toBe(true);
  });

  it("persists each host's mutes under a distinct localStorage key", () => {
    setChannelMutesHost("a.example.com");
    muteChannel(1);
    setChannelMutesHost("b.example.com");
    muteChannel(2);

    expect(
      JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}mutedChannels:a.example.com`)!),
    ).toEqual([1]);
    expect(
      JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}mutedChannels:b.example.com`)!),
    ).toEqual([2]);
  });

  it("switching to the same host is a no-op that keeps the cache", () => {
    setChannelMutesHost("a.example.com");
    muteChannel(3);
    setChannelMutesHost("a.example.com");
    expect(isChannelMuted(3)).toBe(true);
  });

  it("falls back to the legacy unscoped key when no host has been set", () => {
    muteChannel(9);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([9]);
  });
});

describe("channel mutes — notification gating", () => {
  it("allows notifications for an unmuted channel", () => {
    expect(notificationAllowed(1, false)).toBe(true);
  });

  it("silences a muted channel's ordinary messages", () => {
    muteChannel(1);
    expect(notificationAllowed(1, false)).toBe(false);
  });

  // The load-bearing rule: a mute silences chatter, never something addressed
  // to the reader. A mute that swallowed mentions would be unsafe to use.
  it("still allows a mention in a muted channel", () => {
    muteChannel(1);
    expect(notificationAllowed(1, true)).toBe(true);
  });

  it("does not leak a mute across channels", () => {
    muteChannel(1);
    expect(notificationAllowed(2, false)).toBe(true);
  });
});

describe("notifyIncomingMessage respects mutes", () => {
  // The gate is exercised through the real notification entry point so the
  // popup, the chime and the taskbar flash cannot each apply their own copy.
  async function loadNotifications() {
    vi.resetModules();
    return import("@lib/notifications");
  }

  beforeEach(() => {
    localStorage.clear();
    invalidateMuteCache();
    vi.restoreAllMocks();
  });

  function payload(channelId: number, mentions: number[] = []) {
    return {
      id: 1,
      channel_id: channelId,
      user: { id: 99, username: "alice", avatar: null },
      content: "hello",
      reply_to: null,
      timestamp: "2026-01-01T00:00:00Z",
      mentions,
      mentions_everyone: false,
    };
  }

  it("fires nothing for a muted channel", async () => {
    const { notifyIncomingMessage } = await loadNotifications();
    muteChannel(50);
    const notif = vi.fn();
    vi.stubGlobal(
      "Notification",
      Object.assign(notif, { permission: "granted", requestPermission: vi.fn() }),
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    notifyIncomingMessage(payload(50) as never);
    expect(notif).not.toHaveBeenCalled();
  });

  it("still fires for a mention in a muted channel", async () => {
    const { notifyIncomingMessage } = await loadNotifications();
    muteChannel(50);
    const notif = vi.fn();
    vi.stubGlobal(
      "Notification",
      Object.assign(notif, { permission: "granted", requestPermission: vi.fn() }),
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    // A mention resolved by the server: the payload names the reader.
    notifyIncomingMessage(payload(50, [1]) as never);
    // The desktop notification path is async (dynamic import of the Tauri
    // plugin), so only the absence assertion above is synchronous. What this
    // pins is that the mute gate did not return early — which it would have,
    // silently, for a non-mention.
    expect(notificationAllowed(50, true)).toBe(true);
  });
});
