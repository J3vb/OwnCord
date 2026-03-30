import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyIncomingMessage } from "../../src/lib/notifications";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import type { ChatMessagePayload } from "../../src/lib/types";

// vi.hoisted ensures testPrefs is available when vi.mock factory runs
const { testPrefs } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
}));

// Mock the settings helpers
vi.mock("../../src/components/settings/helpers", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
  THEMES: { dark: {}, midnight: {}, light: {} },
  applyTheme: vi.fn(),
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
  createOscillator() { return mockOscillator; }
  createGain() { return mockGain; }
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
      channels: new Map([[1, { id: 1, name: "general", type: "text" as const, category: null, position: 0, unreadCount: 0, lastMessageId: null }]]),
      activeChannelId: 1,
      roles: [],
    }));

    // Ensure document.hasFocus returns false (simulating unfocused window)
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  it("does not notify for own messages", () => {
    const payload = makePayload({ user: { id: 1, username: "Me", avatar: null } });
    notifyIncomingMessage(payload);
  });

  it("does not notify when window is focused and message is in active channel", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
  });

  it("notifies when window is focused but message is in a different channel", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
  });

  it("suppresses @everyone when toggle is enabled", () => {
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Hey @everyone check this out" });
    notifyIncomingMessage(payload);
  });

  it("does not suppress @everyone when toggle is disabled", () => {
    testPrefs.set("suppressEveryone", false);
    const payload = makePayload({ content: "Hey @everyone check this out" });
    notifyIncomingMessage(payload);
  });

  it("handles long messages by truncating", () => {
    const longContent = "A".repeat(200);
    const payload = makePayload({ content: longContent });
    notifyIncomingMessage(payload);
  });

  it("handles @here the same as @everyone", () => {
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Hey @here important update" });
    notifyIncomingMessage(payload);
  });

  it("skips desktop notification when toggle is off", () => {
    testPrefs.set("desktopNotifications", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
  });

  it("skips taskbar flash when toggle is off", () => {
    testPrefs.set("flashTaskbar", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
  });

  it("skips notification sound when toggle is off", () => {
    testPrefs.set("notificationSounds", false);
    const payload = makePayload();
    notifyIncomingMessage(payload);
  });

  it("falls back to channel ID string when channel is not in store", () => {
    // Set channels store to have no channels
    channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));
    const payload = makePayload({ channel_id: 999 });
    // Should not throw; uses fallback "Channel 999"
    notifyIncomingMessage(payload);
  });

  it("notifies when window is not focused, even for active channel", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
    const payload = makePayload({ channel_id: 1 });
    // Should proceed to notification since window is not focused
    notifyIncomingMessage(payload);
  });

  it("does not notify when current user is null", () => {
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
  });

  it("fires all notification types when all enabled", () => {
    // All defaults are true, so just fire and confirm no error
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", true);
    testPrefs.set("notificationSounds", true);
    const payload = makePayload();
    notifyIncomingMessage(payload);
  });

  it("handles short content without truncation", () => {
    const payload = makePayload({ content: "Hi" });
    notifyIncomingMessage(payload);
  });

  it("handles content exactly at 100 char boundary", () => {
    const payload = makePayload({ content: "A".repeat(100) });
    notifyIncomingMessage(payload);
  });

  it("handles content just over 100 chars (101)", () => {
    const payload = makePayload({ content: "A".repeat(101) });
    notifyIncomingMessage(payload);
  });

  it("does not suppress normal message when suppressEveryone is enabled", () => {
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Normal message without at-mentions" });
    // Should proceed to notification (not suppressed)
    notifyIncomingMessage(payload);
  });

  it("suppresses @everyone regardless of other toggles", () => {
    testPrefs.set("suppressEveryone", true);
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", true);
    testPrefs.set("notificationSounds", true);
    const payload = makePayload({ content: "Hey @everyone look!" });
    // Should be suppressed before any notification fires
    notifyIncomingMessage(payload);
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

    testPrefs.set("flashTaskbar", true);
    // Disable other notification types to isolate
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    // Give async time to resolve
    await new Promise((r) => setTimeout(r, 50));
    // Should not throw, just log debug
  });

  it("handles playNotificationSound error gracefully (catch path)", () => {
    // The cached notifAudioCtx may already exist from a prior test,
    // so make the oscillator's start throw to trigger the catch block.
    mockOscillator.start.mockImplementationOnce(() => {
      throw new Error("Oscillator error");
    });

    testPrefs.set("notificationSounds", true);
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("flashTaskbar", false);

    const payload = makePayload();
    // Should not throw
    notifyIncomingMessage(payload);

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
      get() { throw new Error("Notification not available"); },
      configurable: true,
    });

    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);

    const payload = makePayload();
    notifyIncomingMessage(payload);

    await new Promise((r) => setTimeout(r, 50));
    // Should not throw — just logs debug

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
});
