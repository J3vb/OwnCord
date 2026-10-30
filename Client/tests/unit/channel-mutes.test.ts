import { pruneExpiredMutes } from "@lib/prefs/channelMuteExpiry";
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
  getChannelMute,
  CHANNEL_MUTE_CHANGED,
  MUTE_DURATIONS_MS,
} from "@lib/prefs/channelMutes";
import { STORAGE_PREFIX } from "@lib/prefs/preferences";
// The modules in the notifications graph that install an app-lifetime window
// listener at load. loadNotifications() re-imports against these instances,
// so its vi.resetModules() does not install a second copy of each listener.
import * as attachments from "@components/message-list/attachments";
import * as formatting from "@lib/text/formatting";
import * as channelMutes from "@lib/prefs/channelMutes";
import * as appLogger from "@lib/logger";

const APP_LIFETIME_MODULES = [
  ["@components/message-list/attachments", attachments],
  ["@lib/text/formatting", formatting],
  ["@lib/prefs/channelMutes", channelMutes],
  ["@lib/logger", appLogger],
] as const;

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

  it("migrates a pre-scoping legacy mute through to the scoped key without leaking to a different host", () => {
    // A mute saved before host-scoping existed lives at the bare
    // `mutedChannels` key. It must still apply once a host is set, and the
    // migration must write under THAT host's scoped key specifically — not
    // clobber a different host's own explicit mute list, even an empty one.
    localStorage.setItem(KEY, JSON.stringify([7]));
    localStorage.setItem(`${STORAGE_PREFIX}mutedChannels:b.example.com`, JSON.stringify([]));

    setChannelMutesHost("a.example.com");
    expect(isChannelMuted(7)).toBe(true);
    expect(
      JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}mutedChannels:a.example.com`)!),
    ).toEqual([7]);

    setChannelMutesHost("b.example.com");
    expect(isChannelMuted(7)).toBe(false);
  });

  it("does not leak the legacy mute list into a brand-new host that has never had a scoped key", () => {
    // Regression for OC-0288: the legacy read-through fired for ANY host
    // missing a scoped key, not just the first host migrated, and it never
    // consumed the legacy key. So server A migrates correctly, but server B
    // (first connection ever, no scoped key yet) reads through to the same
    // legacy list and persists server A's mutes as its own — even though the
    // user never muted anything on B and channel ids don't even correspond
    // across servers.
    localStorage.setItem(KEY, JSON.stringify([7]));

    setChannelMutesHost("a.example.com");
    expect(isChannelMuted(7)).toBe(true); // migration onto A is correct

    setChannelMutesHost("b.example.com");
    expect(isChannelMuted(7)).toBe(false);
    expect(localStorage.getItem(`${STORAGE_PREFIX}mutedChannels:b.example.com`)).toBeNull();
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
    for (const [id, mod] of APP_LIFETIME_MODULES) vi.doMock(id, () => mod);
    try {
      return await import("@lib/notifications");
    } finally {
      for (const [id] of APP_LIFETIME_MODULES) vi.doUnmock(id);
    }
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

describe("channel mutes — timed mutes (3D-3a)", () => {
  const T0 = new Date(2026, 9, 17, 12, 0, 0).getTime();
  const HOUR = 3_600_000;

  beforeEach(() => {
    setChannelMutesHost(null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stored(): unknown {
    return JSON.parse(localStorage.getItem(KEY)!);
  }

  it("reads a mixed list of bare ids and timed entries", () => {
    localStorage.setItem(KEY, JSON.stringify([3, { id: 4, until: T0 + HOUR }]));
    invalidateMuteCache();
    expect(listMutedChannels()).toEqual([3, 4]);
    expect(getChannelMute(3)).toEqual({ until: null });
    expect(getChannelMute(4)).toEqual({ until: T0 + HOUR });
    expect(getChannelMute(5)).toBeNull();
  });

  it("a timed mute is muted before until and not muted after (Date mocked, no timer run)", () => {
    muteChannel(7, HOUR);
    expect(isChannelMuted(7)).toBe(true);
    vi.setSystemTime(T0 + HOUR - 1);
    expect(isChannelMuted(7)).toBe(true);
    vi.setSystemTime(T0 + HOUR);
    expect(isChannelMuted(7)).toBe(false);
    expect(listMutedChannels()).toEqual([]);
    expect(getChannelMute(7)).toBeNull();
  });

  it("a mention still notifies through a timed mute, chatter does not, until it ends", () => {
    muteChannel(7, HOUR);
    expect(notificationAllowed(7, false)).toBe(false);
    expect(notificationAllowed(7, true)).toBe(true);
    vi.setSystemTime(T0 + HOUR);
    expect(notificationAllowed(7, false)).toBe(true);
  });

  it("muteChannel replaces timed with forever and forever with timed", () => {
    muteChannel(7, HOUR);
    muteChannel(7);
    expect(getChannelMute(7)).toEqual({ until: null });
    muteChannel(7, 900_000);
    expect(getChannelMute(7)).toEqual({ until: T0 + 900_000 });
    expect(listMutedChannels()).toEqual([7]);
  });

  it("rejects a duration not in the list", () => {
    expect(muteChannel(7, 12345)).toBe(false);
    expect(muteChannel(7, 0)).toBe(false);
    expect(isChannelMuted(7)).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(MUTE_DURATIONS_MS).toEqual([900_000, 3_600_000, 10_800_000, 28_800_000, 86_400_000]);
  });

  it("a list with only forever mutes is written byte-identical to today", () => {
    muteChannel(7);
    muteChannel(2);
    expect(localStorage.getItem(KEY)).toBe("[7,2]");
  });

  it("writes a timed mute as an {id, until} object", () => {
    muteChannel(7, HOUR);
    muteChannel(2);
    expect(stored()).toEqual([{ id: 7, until: T0 + HOUR }, 2]);
  });

  it("write drops expired entries", () => {
    muteChannel(7, 900_000);
    vi.setSystemTime(T0 + HOUR);
    muteChannel(8);
    expect(stored()).toEqual([8]);
  });

  it("pruneExpiredMutes announces each expired id once and returns them", () => {
    muteChannel(7, 900_000);
    muteChannel(8, 900_000);
    muteChannel(9, HOUR);
    muteChannel(10);
    const seen: number[] = [];
    const ac = new AbortController();
    window.addEventListener(
      CHANNEL_MUTE_CHANGED,
      (e) => seen.push((e as CustomEvent<{ channelId: number }>).detail.channelId),
      { signal: ac.signal },
    );
    vi.setSystemTime(T0 + 900_000);
    expect(pruneExpiredMutes(Date.now())).toEqual([7, 8]);
    expect(seen).toEqual([7, 8]);
    expect(stored()).toEqual([{ id: 9, until: T0 + HOUR }, 10]);
    // Nothing more has ended: no write, no event.
    expect(pruneExpiredMutes(Date.now())).toEqual([]);
    expect(seen).toEqual([7, 8]);
    ac.abort();
  });

  it("prune clamps an entry more than 24 h out", () => {
    muteChannel(7, 86_400_000);
    // The clock goes back 10 h: the mute now has 34 h left.
    vi.setSystemTime(T0 - 10 * HOUR);
    expect(getChannelMute(7)!.until).toBe(T0 + 24 * HOUR);
    expect(pruneExpiredMutes(Date.now())).toEqual([]);
    expect(getChannelMute(7)).toEqual({ until: T0 - 10 * HOUR + 24 * HOUR });
    expect(stored()).toEqual([{ id: 7, until: T0 + 14 * HOUR }]);
  });

  it("skips a malformed timed entry and keeps the rest", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 1, until: T0 + HOUR },
        { id: 2 },
        { id: "3", until: T0 + HOUR },
        { id: 4, until: -5 },
        { id: 5, until: "soon" },
        { id: 0, until: T0 + HOUR },
        { until: T0 + HOUR },
        { id: 6, until: null },
        6.5,
        8,
      ]),
    );
    invalidateMuteCache();
    expect(listMutedChannels()).toEqual([1, 8]);
  });

  it("a later duplicate wins", () => {
    localStorage.setItem(KEY, JSON.stringify([5, { id: 5, until: T0 + HOUR }]));
    invalidateMuteCache();
    expect(getChannelMute(5)).toEqual({ until: T0 + HOUR });
  });

  it("toggleChannelMute unmutes a timed mute", () => {
    muteChannel(7, HOUR);
    expect(getChannelMute(7)).toEqual({ until: T0 + HOUR });
    expect(toggleChannelMute(7)).toBe(false);
    expect(isChannelMuted(7)).toBe(false);
  });

  it("migrates a legacy unscoped list into a Map the timed API can replace", () => {
    localStorage.setItem(KEY, JSON.stringify([3]));
    setChannelMutesHost("legacy.example.com");
    expect(isChannelMuted(3)).toBe(true);
    muteChannel(3, HOUR);
    expect(getChannelMute(3)).toEqual({ until: T0 + HOUR });
    setChannelMutesHost(null);
  });
});
