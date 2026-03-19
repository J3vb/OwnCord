import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyIncomingMessage } from "../../src/lib/notifications";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import type { ChatMessagePayload } from "../../src/lib/types";

// Track prefs in a shared map we can reset
const testPrefs = new Map<string, unknown>();

// Mock the settings helpers
vi.mock("../../src/components/settings/helpers", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
  THEMES: { dark: {}, midnight: {}, light: {} },
  applyTheme: vi.fn(),
}));

// Mock Tauri notification plugin (not available in test env)
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
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
});
