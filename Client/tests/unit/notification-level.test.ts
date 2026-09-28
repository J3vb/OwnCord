/**
 * U1(b): a notification level (All / Mentions only / Nothing), global with a
 * per-server override, defaulting to Mentions only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setChannelMutesHost } from "../../src/lib/channel-mutes";

const { testPrefs } = vi.hoisted(() => ({ testPrefs: new Map<string, unknown>() }));

vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

import {
  DEFAULT_NOTIFICATION_LEVEL,
  NOTIFICATION_LEVELS,
  getGlobalNotificationLevel,
  getServerNotificationLevel,
  setGlobalNotificationLevel,
  setServerNotificationLevel,
  clearServerNotificationLevel,
  shouldNotifyForLevel,
} from "../../src/lib/notificationLevel";

describe("notification level storage", () => {
  beforeEach(() => {
    testPrefs.clear();
    localStorage.clear();
    setChannelMutesHost(null);
  });

  it("defaults to mentions only", () => {
    expect(DEFAULT_NOTIFICATION_LEVEL).toBe("mentions");
    expect(getGlobalNotificationLevel()).toBe("mentions");
  });

  it("grandfathers a pre-level install to All so it is not silently quieted", () => {
    // Any notification toggle written by an older client marks this install as
    // already configured; the level migration records All rather than Mentions.
    localStorage.setItem("owncord:settings:desktopNotifications", "false");
    expect(getGlobalNotificationLevel()).toBe("all");
  });

  it("offers exactly all, mentions and nothing", () => {
    expect(NOTIFICATION_LEVELS).toEqual(["all", "mentions", "nothing"]);
  });

  it("round-trips the global level", () => {
    setGlobalNotificationLevel("all");
    expect(getGlobalNotificationLevel()).toBe("all");
    setGlobalNotificationLevel("nothing");
    expect(getGlobalNotificationLevel()).toBe("nothing");
  });

  it("ignores a corrupt stored level and falls back to the default", () => {
    testPrefs.set("notificationLevel", "loud");
    expect(getGlobalNotificationLevel()).toBe("mentions");
  });

  it("reports no per-server override by default", () => {
    setChannelMutesHost("a.example");
    expect(getServerNotificationLevel()).toBeNull();
  });

  it("scopes a per-server override to its host", () => {
    setChannelMutesHost("a.example");
    setServerNotificationLevel("nothing");
    expect(getServerNotificationLevel()).toBe("nothing");

    setChannelMutesHost("b.example");
    expect(getServerNotificationLevel()).toBeNull();
  });

  it("removes a per-server override with clear", () => {
    setChannelMutesHost("a.example");
    setServerNotificationLevel("all");
    clearServerNotificationLevel();
    expect(getServerNotificationLevel()).toBeNull();
  });
});

describe("shouldNotifyForLevel", () => {
  it("never notifies at Nothing, even for a mention", () => {
    expect(shouldNotifyForLevel("nothing", { mentioned: true, isDm: true })).toBe(false);
  });

  it("notifies for every message at All", () => {
    expect(shouldNotifyForLevel("all", { mentioned: false, isDm: false })).toBe(true);
  });

  it("notifies only mentions at Mentions only", () => {
    expect(shouldNotifyForLevel("mentions", { mentioned: true, isDm: false })).toBe(true);
    expect(shouldNotifyForLevel("mentions", { mentioned: false, isDm: false })).toBe(false);
  });

  it("treats a direct message as addressed to you at Mentions only", () => {
    expect(shouldNotifyForLevel("mentions", { mentioned: false, isDm: true })).toBe(true);
  });
});
