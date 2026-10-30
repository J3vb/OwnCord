/**
 * What the notification service registers when it loads, and what a session
 * reset does to it: the burst window starts over and the sound context is
 * released. The service is loaded inside each test so its load-time
 * registrations are part of what is observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelActivityEntry } from "../../src/lib/types";

// Everything the service imports is loaded up front, so the app-lifetime
// listeners those modules install are not mistaken for the service's own.
import "../../src/lib/prefs/preferences";
import "../../src/lib/prefs/channelMutes";
import "../../src/lib/prefs/notificationLevel";
import "../../src/lib/userStatus";
import "../../src/stores/auth.store";
import "../../src/stores/channels.store";
import "../../src/stores/dm.store";
import "../../src/stores/messages.store";
import "../../src/stores/members.store";
import "../../src/stores/blocks.store";
import "../../src/lib/text/messageKind";
import "../../src/lib/text/mentions";
import "../../src/lib/message-navigation";
import "../../src/lib/logger";
import "../../src/lib/sessionRegistry";
import "../../src/lib/notificationSound";
import "../../src/lib/prefs/soundPrefs";
import "../../src/lib/text/formatting";
import "../../src/lib/avatar";
import "../../src/i18n/connect";
import "../../src/lib/text/markdown";

const { notifier } = vi.hoisted(() => ({
  notifier: {
    permissionGranted: vi.fn(),
    requestPermission: vi.fn(),
    showMessage: vi.fn(),
    flashTaskbar: vi.fn(),
  },
}));

vi.mock("../../src/platform/desktop", () => ({ desktop: { notifier } }));

const closeContext = vi.fn().mockResolvedValue(undefined);
class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    return {
      connect: vi.fn(),
      frequency: { setValueAtTime: vi.fn() },
      start: vi.fn(),
      stop: vi.fn(),
    };
  }
  createGain() {
    return {
      connect: vi.fn(),
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    };
  }
  close() {
    return closeContext();
  }
}
(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

const entry: ChannelActivityEntry = {
  channel_id: 1,
  message_id: 42,
  author_id: 2,
  mentions_you: false,
  mentions_everyone: false,
};

function lib() {
  return import("../../src/lib/notifications");
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(async () => {
  localStorage.clear();
  notifier.permissionGranted.mockReset().mockResolvedValue(true);
  notifier.requestPermission.mockReset().mockResolvedValue(true);
  notifier.showMessage.mockReset().mockResolvedValue(undefined);
  notifier.flashTaskbar.mockReset().mockResolvedValue(undefined);
  closeContext.mockClear();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  localStorage.setItem("owncord:settings:notificationLevel", JSON.stringify("all"));
  const { authStore } = await import("../../src/stores/auth.store");
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "Me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  const { channelsStore } = await import("../../src/stores/channels.store");
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: 99 }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  const { setLogLevel } = await import("../../src/lib/logger");
  setLogLevel("warn");
});

describe("the notification service's session registrations", () => {
  it("registers its resets ahead of the voice and domain resets and acts on a session reset", async () => {
    const { notifyChannelActivity, resetNotificationCoalescing } = await lib();
    const { registerSessionReset, listSessionResets, runSessionResets } =
      await import("../../src/lib/sessionRegistry");
    const { playNotificationSound, cleanupNotificationAudio } =
      await import("../../src/lib/notificationSound");
    const { addLogListener, setLogLevel } = await import("../../src/lib/logger");

    // Registered in the session phase, ahead of the voice and domain resets.
    const stopVoice = registerSessionReset("test:voice-probe", () => {}, { phase: "voice" });
    try {
      const order = listSessionResets();
      expect(order).toContain("notifications:audio");
      expect(order).toContain("notifications:coalescing");
      expect(order.indexOf("notifications:audio")).toBeLessThan(order.indexOf("test:voice-probe"));
      expect(order.indexOf("notifications:coalescing")).toBeLessThan(
        order.indexOf("test:voice-probe"),
      );
    } finally {
      stopVoice();
    }

    // A refused taskbar flash is logged under the service's own name.
    resetNotificationCoalescing();
    setLogLevel("debug");
    const entries: Array<{ component: string; message: string }> = [];
    const stop = addLogListener((e) => entries.push(e));
    notifier.flashTaskbar.mockRejectedValueOnce(new Error("no taskbar"));
    try {
      notifyChannelActivity(entry);
      await settle();
    } finally {
      stop();
    }
    expect(entries).toContainEqual(
      expect.objectContaining({
        component: "notifications",
        message: "Taskbar flash not available",
      }),
    );

    // A session reset starts a fresh burst window.
    notifyChannelActivity({ ...entry, message_id: 43 });
    await settle();
    expect(notifier.showMessage).toHaveBeenCalledTimes(1);
    expect(runSessionResets("server_switch")).toEqual([]);
    notifyChannelActivity({ ...entry, message_id: 44 });
    await settle();
    expect(notifier.showMessage).toHaveBeenCalledTimes(2);

    // And releases the sound context.
    cleanupNotificationAudio();
    closeContext.mockClear();
    playNotificationSound();
    expect(closeContext).not.toHaveBeenCalled();
    expect(runSessionResets("user")).toEqual([]);
    expect(closeContext).toHaveBeenCalledTimes(1);
  });
});
