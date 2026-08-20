import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notifyIncomingMessage, cleanupNotificationAudio } from "../../src/lib/notifications";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import type { ChatMessagePayload } from "../../src/lib/types";

// vi.hoisted ensures testPrefs is available when vi.mock factory runs
const { testPrefs } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
}));

// Mock the preference store shared by the settings panel and lib modules
vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

// Mock livekitSession (imported transitively by auth.store)
vi.mock("../../src/lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

// Track whether the tauri notification mock should throw
const { shouldTauriNotifThrow } = vi.hoisted(() => ({
  shouldTauriNotifThrow: { value: false },
}));

// Mock Tauri notification plugin (not available in test env)
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => {
    if (shouldTauriNotifThrow.value) throw new Error("Tauri not available");
    return Promise.resolve(true);
  }),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

// Mock Tauri window API
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    requestUserAttention: vi.fn().mockResolvedValue(undefined),
  }),
}));

function makePayload(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 2, username: "TestUser", avatar: null },
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  } as ChatMessagePayload;
}

// Mock AudioContext for notification sound tests
const mockOscillator = {
  connect: vi.fn(),
  frequency: {
    setValueAtTime: vi.fn(),
  },
  start: vi.fn(),
  stop: vi.fn(),
};
const mockGain = {
  connect: vi.fn(),
  gain: {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  },
};

class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    return mockOscillator;
  }
  createGain() {
    return mockGain;
  }
  close() {
    return Promise.resolve();
  }
}

// Set up AudioContext mock globally
(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

describe("notifyIncomingMessage", () => {
  beforeEach(() => {
    testPrefs.clear();

    // Set up auth store with a different user
    authStore.setState(() => ({
      token: "test",
      user: { id: 1, username: "Me", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));

    // Set up channels store
    channelsStore.setState(() => ({
      channels: new Map([
        [
          1,
          {
            id: 1,
            name: "general",
            type: "text" as const,
            category: null,
            position: 0,
            unreadCount: 0,
            mentionCount: 0,
            lastMessageId: null,
            canSend: true,
            topic: "",
            slowMode: 0,
            nsfw: false,
            voiceMaxUsers: 0,
            voiceMaxVideo: 0,
          },
        ],
      ]),
      activeChannelId: 1,
      roles: [],
    }));

    // DM ids are absent from channelsStore until the conversation is opened
    // (see dispatcher.ts) -- reset so a DM seeded by one test cannot leak
    // into another that expects the plain channelsStore fallback.
    dmStore.setState(() => ({ channels: [] }));

    // Reset the member store so a nickname seeded by one test cannot leak
    // into another that expects the plain-username title.
    membersStore.setState(() => ({
      members: new Map(),
      typingUsers: new Map(),
      roleRevision: 0,
    }));

    // Ensure document.hasFocus returns false (simulating unfocused window)
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  it("does not notify for own messages", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    const payload = makePayload({ user: { id: 1, username: "Me", avatar: null } });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when window is focused and message is in active channel", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("notifies when window is focused but message is in a different channel", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("suppresses @everyone when toggle is enabled", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({
      content: "Hey @everyone check this out",
      mentions_everyone: true,
    });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not suppress @everyone when toggle is disabled", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("suppressEveryone", false);
    const payload = makePayload({ content: "Hey @everyone check this out" });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("handles long messages by truncating", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    const longContent = "A".repeat(200);
    const payload = makePayload({ content: longContent });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "A".repeat(100) + "..." }),
      );
    });
  });

  it("handles @here the same as @everyone", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Hey @here important update", mentions_everyone: true });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("skips desktop notification when toggle is off", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("desktopNotifications", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("skips taskbar flash when toggle is off", async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("flashTaskbar", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(win.requestUserAttention).not.toHaveBeenCalled();
  });

  it("skips notification sound when toggle is off", () => {
    mockOscillator.start.mockClear();
    testPrefs.set("notificationSounds", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
    expect(mockOscillator.start).not.toHaveBeenCalled();
  });

  it("falls back to channel ID string when channel is not in store", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    // Set channels store to have no channels
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    const payload = makePayload({ channel_id: 999 });
    // Should not throw; uses fallback "Channel 999"
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining("Channel 999") }),
      );
    });
  });

  it("notifies when window is not focused, even for active channel", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
    const payload = makePayload({ channel_id: 1 });
    // Should proceed to notification since window is not focused
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  // NOTE: original title was "does not notify when current user is null" but
  // the code (see the guard clause in notifyIncomingMessage: `currentUser !==
  // null && payload.user.id === currentUser.id`) and the original inline
  // comment both make clear a null/logged-out user is NOT treated as a match
  // and the notification proceeds. Renamed to match actual, intended
  // behavior (also covered by "proceeds when current user is null" below).
  it("notifies when current user is null (not logged in)", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    authStore.setState(() => ({
      token: null,
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: false,
    }));
    // payload.user.id = 2 (different from null user), should proceed
    const payload = makePayload();
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("fires all notification types when all enabled", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
    mockOscillator.start.mockClear();

    // All defaults are true, so just fire and confirm all three channels fired
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", true);
    testPrefs.set("notificationSounds", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
      expect(win.requestUserAttention).toHaveBeenCalled();
    });
    expect(mockOscillator.start).toHaveBeenCalled();
  });

  it("handles short content without truncation", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    const payload = makePayload({ content: "Hi" });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "Hi" }));
    });
  });

  it("handles content exactly at 100 char boundary", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    const payload = makePayload({ content: "A".repeat(100) });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "A".repeat(100) }),
      );
    });
  });

  it("handles content just over 100 chars (101)", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    const payload = makePayload({ content: "A".repeat(101) });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "A".repeat(100) + "..." }),
      );
    });
  });

  it("does not suppress normal message when suppressEveryone is enabled", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Normal message without at-mentions" });
    // Should proceed to notification (not suppressed)
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("suppresses @everyone regardless of other toggles", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("suppressEveryone", true);
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", true);
    testPrefs.set("notificationSounds", true);
    const payload = makePayload({ content: "Hey @everyone look!", mentions_everyone: true });
    // Should be suppressed before any notification fires
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("fires desktop notification via Tauri plugin when permission granted", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    testPrefs.set("desktopNotifications", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    // Allow async to complete
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("fires taskbar flash via Tauri window API", async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    testPrefs.set("flashTaskbar", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    await vi.waitFor(() => {
      const win = getCurrentWindow();
      expect(win.requestUserAttention).toHaveBeenCalledWith(2);
    });
  });

  it("requests permission when not yet granted", async () => {
    const mod = await import("@tauri-apps/plugin-notification");
    (mod.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (mod.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("granted");

    testPrefs.set("desktopNotifications", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    await vi.waitFor(() => {
      expect(mod.requestPermission).toHaveBeenCalled();
      expect(mod.sendNotification).toHaveBeenCalled();
    });
  });

  it("does not send notification when permission denied", async () => {
    const mod = await import("@tauri-apps/plugin-notification");
    (mod.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    (mod.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("denied");
    (mod.sendNotification as ReturnType<typeof vi.fn>).mockClear();

    testPrefs.set("desktopNotifications", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    // Give async time to resolve
    await new Promise((r) => setTimeout(r, 50));
    // sendNotification should not have been called after permission denial
    expect(mod.sendNotification).not.toHaveBeenCalled();
  });

  it("handles flashTaskbar error gracefully (catch path)", async () => {
    const winMod = await import("@tauri-apps/api/window");
    (winMod.getCurrentWindow as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("Window not available");
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    testPrefs.set("flashTaskbar", true);
    // Disable other notification types to isolate
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    // Give async time to resolve
    await new Promise((r) => setTimeout(r, 50));
    // Should not throw, and the catch path should have logged via the
    // notifications logger (console.debug is its underlying sink).
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("[notifications]"),
      "Taskbar flash not available",
      "",
    );

    debugSpy.mockRestore();
  });

  it("handles playNotificationSound error gracefully (catch path)", () => {
    // The cached notifAudioCtx may already exist from a prior test,
    // so make the oscillator's start throw to trigger the catch block.
    mockOscillator.start.mockImplementationOnce(() => {
      throw new Error("Oscillator error");
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    testPrefs.set("notificationSounds", true);
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("flashTaskbar", false);

    const payload = makePayload();
    // Should not throw
    notifyIncomingMessage(payload);

    // The catch block logs via the notifications logger before returning.
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("[notifications]"),
      "Notification sound not available",
      "",
    );

    debugSpy.mockRestore();
    // Restore the mock
    mockOscillator.start.mockImplementation(() => {});
  });

  it("falls back to Web Notification API when Tauri notification throws (permission granted)", async () => {
    shouldTauriNotifThrow.value = true;

    // Mock Web Notification API
    const mockWebNotification = vi.fn();
    const originalNotification = globalThis.Notification;
    (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
      permission: "granted",
      requestPermission: vi.fn(),
    });

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockWebNotification).toHaveBeenCalled();

    shouldTauriNotifThrow.value = false;
    (globalThis as Record<string, unknown>).Notification = originalNotification;
  });

  it("falls back to Web Notification API and requests permission when not granted/denied", async () => {
    shouldTauriNotifThrow.value = true;

    const mockWebNotification = vi.fn();
    const mockRequestPerm = vi.fn().mockResolvedValue("granted");
    const originalNotification = globalThis.Notification;
    (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
      permission: "default",
      requestPermission: mockRequestPerm,
    });

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockRequestPerm).toHaveBeenCalled();
    expect(mockWebNotification).toHaveBeenCalled();

    shouldTauriNotifThrow.value = false;
    (globalThis as Record<string, unknown>).Notification = originalNotification;
  });

  it("does not show Web Notification when permission is denied", async () => {
    shouldTauriNotifThrow.value = true;

    const mockWebNotification = vi.fn();
    const originalNotification = globalThis.Notification;
    (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
      permission: "denied",
      requestPermission: vi.fn(),
    });

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockWebNotification).not.toHaveBeenCalled();

    shouldTauriNotifThrow.value = false;
    (globalThis as Record<string, unknown>).Notification = originalNotification;
  });

  it("handles Web Notification API also failing (double catch)", async () => {
    shouldTauriNotifThrow.value = true;

    // Remove Notification entirely to trigger the inner catch
    const originalNotification = globalThis.Notification;
    Object.defineProperty(globalThis, "Notification", {
      get() {
        throw new Error("Notification not available");
      },
      configurable: true,
    });

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));
    // Should not throw — and the inner catch should have logged via the
    // notifications logger.
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("[notifications]"),
      "Notifications not available",
      "",
    );

    debugSpy.mockRestore();
    shouldTauriNotifThrow.value = false;
    Object.defineProperty(globalThis, "Notification", {
      value: originalNotification,
      configurable: true,
      writable: true,
    });
  });

  it("does not create Web Notification when requestPermission returns non-granted", async () => {
    shouldTauriNotifThrow.value = true;

    const mockWebNotification = vi.fn();
    const mockRequestPerm = vi.fn().mockResolvedValue("denied");
    const originalNotification = globalThis.Notification;
    (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
      permission: "default",
      requestPermission: mockRequestPerm,
    });

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockRequestPerm).toHaveBeenCalled();
    // Should not construct a Notification since permission denied
    expect(mockWebNotification).not.toHaveBeenCalled();

    shouldTauriNotifThrow.value = false;
    (globalThis as Record<string, unknown>).Notification = originalNotification;
  });

  // =========================================================================
  // Mutation-killing tests: verify exact argument values, boundary conditions,
  // boolean/arithmetic/string mutations.
  // =========================================================================

  describe("sendNotification receives correct title and body", () => {
    it("passes title with format 'username in #channelName'", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "Alice", avatar: null },
        channel_id: 1,
        content: "Hey there!",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith({
          title: "Alice in #general",
          body: "Hey there!",
        });
      });
    });

    // DM channel ids are never in channelsStore until the conversation is
    // opened, so a DM notification used to fall back to "Channel <id>" --
    // dm.store.ts names dmDisplayName as the one place every DM-labelling
    // surface (sidebar, header, quick switcher, notification title) must
    // agree, so the title routes through it too, with no "#" (a DM is not a
    // channel).
    it("titles a DM notification from dmDisplayName, not the channelsStore fallback", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      const dm: DmChannel = {
        channelId: 55,
        recipient: { id: 2, username: "bob", avatar: "", status: "online" },
        participants: [{ id: 2, username: "bob", avatar: "", status: "online" }],
        name: "",
        isGroup: false,
        lastMessageId: null,
        lastMessage: "",
        lastMessageAt: "",
        unreadCount: 0,
        mentionCount: 0,
      };
      dmStore.setState(() => ({ channels: [dm] }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "bob", avatar: null },
        channel_id: 55,
        content: "hey",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith({
          title: "bob in bob",
          body: "hey",
        });
      });
    });

    // OC-0233: the popup that tells you who wrote to you has to name them the
    // same way the message row you click through to does. resolveAuthor
    // (message-list/formatting.ts) prefers the live membersStore copy of the
    // author's nickname over whatever was frozen into the payload.
    it("titles the notification with the member store's nickname, not the raw username", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      membersStore.setState(() => ({
        members: new Map([
          [
            2,
            {
              id: 2,
              username: "a_martinez",
              avatar: null,
              role: "member",
              status: "online" as const,
              displayName: "Alice",
            },
          ],
        ]),
        typingUsers: new Map(),
        roleRevision: 1,
      }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "a_martinez", avatar: null },
        channel_id: 1,
        content: "hi",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith({
          title: "Alice in #general",
          body: "hi",
        });
      });
    });

    // Same fix, payload-only path: the author has a display_name on the
    // message but is not (yet) in the member store.
    it("titles the notification with the payload's display_name when the author is not in the member store", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "a_martinez", avatar: null, display_name: "Alice" },
        channel_id: 1,
        content: "hi",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith({
          title: "Alice in #general",
          body: "hi",
        });
      });
    });

    it("uses fallback channel name with correct channel ID", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "Bob", avatar: null },
        channel_id: 42,
        content: "test",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledWith({
          title: "Bob in #Channel 42",
          body: "test",
        });
      });
    });
  });

  describe("sanitizeNotif: truncation boundary and control chars", () => {
    it("title at exactly 80 chars is NOT truncated", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      // "X in #general" = 13 chars. We need username to make title exactly 80.
      // title = `${username} in #general` => username.length + 12 = 80 => 68
      const username = "U".repeat(68);

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username, avatar: null },
        channel_id: 1,
        content: "x",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe(`${"U".repeat(68)} in #general`);
        expect(call.title.length).toBe(80);
        // Should NOT end with "..."
        expect(call.title.endsWith("...")).toBe(false);
      });
    });

    it("title at 81 chars IS truncated with '...'", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      // title = `${username} in #general` => username.length + 12 = 81 => 69
      const username = "U".repeat(69);

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username, avatar: null },
        channel_id: 1,
        content: "x",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title.endsWith("...")).toBe(true);
        // Truncated to 80 chars + "..." = 83
        expect(call.title.length).toBe(83);
      });
    });

    it("body at exactly 100 chars is NOT truncated", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const content = "B".repeat(100);
      const payload = makePayload({
        user: { id: 2, username: "X", avatar: null },
        channel_id: 1,
        content,
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body).toBe("B".repeat(100));
        expect(call.body.endsWith("...")).toBe(false);
      });
    });

    it("body at 101 chars IS truncated with '...'", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const content = "B".repeat(101);
      const payload = makePayload({
        user: { id: 2, username: "X", avatar: null },
        channel_id: 1,
        content,
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body.endsWith("...")).toBe(true);
        expect(call.body.length).toBe(103); // 100 + "..."
      });
    });

    it("strips control characters from username and content", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "Evil\x00\x1FUser\x7F", avatar: null },
        channel_id: 1,
        content: "Hello\x00World\x1F!\x7F",
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe("EvilUser in #general");
        expect(call.body).toBe("HelloWorld!");
      });
    });

    it("control chars are removed before length check (not counted)", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      // 100 visible chars + 5 control chars => after strip = 100, should NOT truncate
      const content = "C".repeat(100) + "\x00\x01\x02\x03\x04";
      const payload = makePayload({
        user: { id: 2, username: "U", avatar: null },
        channel_id: 1,
        content,
      });
      notifyIncomingMessage(payload);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body).toBe("C".repeat(100));
        expect(call.body.endsWith("...")).toBe(false);
      });
    });
  });

  describe("suppressEveryone: driven by mentions_everyone, not substrings", () => {
    it("suppresses an @everyone the server honoured", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", true);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ content: "ping @everyone", mentions_everyone: true }));

      await new Promise((r) => setTimeout(r, 50));
      // Should NOT have reached sendNotification
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("suppresses an @here the server honoured", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", true);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ content: "ping @here", mentions_everyone: true }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("does NOT suppress an @everyone the server did not honour", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", true);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      // Sender lacked MENTION_EVERYONE: the token is plain text.
      notifyIncomingMessage(makePayload({ content: "ping @everyone", mentions_everyone: false }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("does NOT suppress an @everyone that also names the user", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", true);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(
        makePayload({ content: "@everyone and @Me", mentions: [1], mentions_everyone: true }),
      );

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe("TestUser mentioned you in #general");
      });
    });

    it("does NOT suppress message without @everyone or @here even with toggle on", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", true);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ content: "just a normal message" }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("does NOT suppress @everyone when suppressEveryone pref is false", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("suppressEveryone", false);
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ content: "Hey @everyone", mentions_everyone: true }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("guard clause: own message check", () => {
    it("skips notification when payload user ID matches current user ID exactly", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);

      // Current user id=1, payload user id=1
      const payload = makePayload({ user: { id: 1, username: "Me", avatar: null } });
      notifyIncomingMessage(payload);

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("proceeds when current user is null (not logged in) — does not crash", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      authStore.setState(() => ({
        token: null,
        user: null,
        serverName: null,
        motd: null,
        isAuthenticated: false,
      }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("proceeds when payload user ID differs from current user ID", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      // Current user id=1, payload user id=2 (different)
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ user: { id: 2, username: "Other", avatar: null } }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("guard clause: focused window + active channel", () => {
    it("skips when BOTH window focused AND channel matches (AND, not OR)", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      testPrefs.set("desktopNotifications", true);

      notifyIncomingMessage(makePayload({ channel_id: 1 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("proceeds when window focused but channel DIFFERS", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ channel_id: 1 }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("proceeds when window NOT focused even for active channel", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ channel_id: 1 }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("notification toggles independently control each action", () => {
    it("fires ONLY desktop notification when other toggles are off", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      mockOscillator.start.mockClear();

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });

      // Sound oscillator should not have been started
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("fires ONLY notification sound when other toggles are off", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);

      mockOscillator.start.mockClear();

      notifyIncomingMessage(makePayload());

      await new Promise((r) => setTimeout(r, 50));

      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).toHaveBeenCalled();
    });

    it("fires ONLY taskbar flash when other toggles are off", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        const win = getCurrentWindow();
        expect(win.requestUserAttention).toHaveBeenCalled();
      });

      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });
  });

  describe("Do Not Disturb", () => {
    it("suppresses the desktop notification and the sound while DND", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("notificationSounds", true);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("userStatus", "dnd");

      notifyIncomingMessage(makePayload());

      // The taskbar flash still fires — it's the one passive cue DND keeps.
      await vi.waitFor(() => {
        const win = getCurrentWindow();
        expect(win.requestUserAttention).toHaveBeenCalled();
      });

      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("still notifies for other statuses", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("userStatus", "idle");

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("playNotificationSound: oscillator params", () => {
    it("sets frequency to 800 then 600", () => {
      mockOscillator.frequency.setValueAtTime.mockClear();
      mockGain.gain.setValueAtTime.mockClear();
      mockGain.gain.exponentialRampToValueAtTime.mockClear();
      mockOscillator.start.mockClear();
      mockOscillator.stop.mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);

      notifyIncomingMessage(makePayload());

      // Verify exact frequency values (kills arithmetic mutations)
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(800, 0);
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(600, 0.1);
    });

    it("sets gain to 0.3 and ramps to 0.01", () => {
      mockGain.gain.setValueAtTime.mockClear();
      mockGain.gain.exponentialRampToValueAtTime.mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);

      notifyIncomingMessage(makePayload());

      expect(mockGain.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
      expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.01, 0.2);
    });

    it("starts oscillator at currentTime and stops at currentTime + 0.2", () => {
      mockOscillator.start.mockClear();
      mockOscillator.stop.mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);

      notifyIncomingMessage(makePayload());

      expect(mockOscillator.start).toHaveBeenCalledWith(0);
      expect(mockOscillator.stop).toHaveBeenCalledWith(0.2);
    });

    it("connects oscillator -> gain -> destination", () => {
      mockOscillator.connect.mockClear();
      mockGain.connect.mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);

      notifyIncomingMessage(makePayload());

      expect(mockOscillator.connect).toHaveBeenCalledWith(mockGain);
      expect(mockGain.connect).toHaveBeenCalled();
    });
  });

  describe("cleanupNotificationAudio", () => {
    it("calls close() on the AudioContext when one exists", () => {
      // First, ensure an AudioContext is created by playing a sound
      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", true);
      notifyIncomingMessage(makePayload());

      // Now add a close mock to the prototype
      const closeMock = vi.fn().mockResolvedValue(undefined);
      MockAudioContext.prototype.close = closeMock;

      cleanupNotificationAudio();

      // After cleanup, calling again should be a no-op
      closeMock.mockClear();
      cleanupNotificationAudio();
      expect(closeMock).not.toHaveBeenCalled();
    });

    it("is a no-op when no AudioContext exists", () => {
      // Ensure no context by cleaning up first
      cleanupNotificationAudio();
      // Calling again should not throw
      expect(() => cleanupNotificationAudio()).not.toThrow();
    });
  });

  describe("flashTaskbar: exact attention type argument", () => {
    it("requests informational attention (type 2, not 1 or 0)", async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", false);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(win.requestUserAttention).toHaveBeenCalledWith(2);
        expect(win.requestUserAttention).not.toHaveBeenCalledWith(1);
        expect(win.requestUserAttention).not.toHaveBeenCalledWith(0);
      });
    });
  });

  describe("fireDesktopNotification: permission flow", () => {
    it("sends notification directly when already permitted (no requestPermission call)", async () => {
      const mod = await import("@tauri-apps/plugin-notification");
      (mod.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      (mod.requestPermission as ReturnType<typeof vi.fn>).mockClear();
      (mod.sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(mod.sendNotification).toHaveBeenCalled();
      });
      expect(mod.requestPermission).not.toHaveBeenCalled();
    });

    it("does NOT send when permission request returns non-'granted' string", async () => {
      const mod = await import("@tauri-apps/plugin-notification");
      (mod.isPermissionGranted as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
      (mod.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce("default");
      (mod.sendNotification as ReturnType<typeof vi.fn>).mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await new Promise((r) => setTimeout(r, 50));
      expect(mod.sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("Web Notification fallback: exact permission string checks", () => {
    afterEach(() => {
      shouldTauriNotifThrow.value = false;
    });

    it("creates Notification with correct title and body when permission is 'granted'", async () => {
      shouldTauriNotifThrow.value = true;

      const mockWebNotification = vi.fn();
      const originalNotification = globalThis.Notification;
      (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
        permission: "granted",
        requestPermission: vi.fn(),
      });

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      const payload = makePayload({
        user: { id: 2, username: "WebUser", avatar: null },
        channel_id: 1,
        content: "web notif test",
      });
      notifyIncomingMessage(payload);

      await new Promise((r) => setTimeout(r, 50));

      expect(mockWebNotification).toHaveBeenCalledWith("WebUser in #general", {
        body: "web notif test",
      });

      (globalThis as Record<string, unknown>).Notification = originalNotification;
    });

    it("skips Notification.requestPermission when permission is exactly 'denied'", async () => {
      shouldTauriNotifThrow.value = true;

      const mockWebNotification = vi.fn();
      const mockRequestPerm = vi.fn();
      const originalNotification = globalThis.Notification;
      (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
        permission: "denied",
        requestPermission: mockRequestPerm,
      });

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload());

      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestPerm).not.toHaveBeenCalled();
      expect(mockWebNotification).not.toHaveBeenCalled();

      (globalThis as Record<string, unknown>).Notification = originalNotification;
    });
  });
  describe("mention titles", () => {
    async function titleFor(payload: ChatMessagePayload): Promise<string> {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);
      notifyIncomingMessage(payload);
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
      return (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0].title as string;
    }

    it("says 'mentioned you' when the server names the current user", async () => {
      const title = await titleFor(makePayload({ content: "hi @Me", mentions: [1] }));
      expect(title).toBe("TestUser mentioned you in #general");
    });

    it("says 'mentioned you' for an honoured @everyone", async () => {
      const title = await titleFor(
        makePayload({ content: "hi all @everyone", mentions_everyone: true }),
      );
      expect(title).toBe("TestUser mentioned you in #general");
    });

    it("uses the plain title when the mention names someone else", async () => {
      const title = await titleFor(makePayload({ content: "hi @other", mentions: [7] }));
      expect(title).toBe("TestUser in #general");
    });

    it("uses the plain title for an unhonoured @everyone", async () => {
      const title = await titleFor(
        makePayload({ content: "hi @everyone", mentions_everyone: false }),
      );
      expect(title).toBe("TestUser in #general");
    });

    it("falls back to name resolution when the server sent no list", async () => {
      const title = await titleFor(makePayload({ content: "hi @Me" }));
      expect(title).toBe("TestUser mentioned you in #general");
    });

    it("stays silent under Do Not Disturb even for a mention", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("userStatus", "dnd");
      testPrefs.set("desktopNotifications", true);

      notifyIncomingMessage(makePayload({ content: "hi @Me", mentions: [1] }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });
  });
});
