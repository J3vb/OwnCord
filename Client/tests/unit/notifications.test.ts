import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  notifyChannelActivity,
  notifyIncomingMessage,
  notifyMention,
  openMessageTarget,
  resetNotificationCoalescing,
} from "../../src/lib/notifications";
import { cleanupNotificationAudio } from "../../src/lib/media/notificationSound";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import type { DmChannel } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import { messagesStore } from "../../src/stores/messages.store";
import { setBlockedByMe } from "../../src/stores/blocks.store";
import type { ChannelActivityEntry, ChatMessagePayload } from "../../src/lib/types";
import { setLogLevel } from "../../src/lib/logger";
import { muteChannel, setChannelMutesHost, unmuteChannel } from "../../src/lib/prefs/channelMutes";
import { setMessageJumpHandler } from "../../src/lib/nav/messageNavigation";

// The three tests that assert on the logger's debug lines raise the level the
// global setup lowered (C-04) for themselves; this puts it back.
afterEach(() => {
  setLogLevel("warn");
});

// vi.hoisted ensures testPrefs is available when vi.mock factory runs
const { testPrefs } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
}));

// Mock the preference store shared by the settings panel and lib modules
vi.mock("../../src/lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

// Mock livekitSession (imported transitively by auth.store)
vi.mock("../../src/lib/voice/livekitSession", () => ({
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

// The shared notification mock. The native path now shows a *message*
// notification through the host's `notify_message` command (so a click can
// open the message), and the plugin's `sendNotification` is only reached when
// that command is unavailable — so the mocked invoker forwards to it, and the
// existing title/body assertions keep observing the same call.
const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));

// Mock Tauri notification plugin (not available in test env)
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => {
    if (shouldTauriNotifThrow.value) throw new Error("Tauri not available");
    return Promise.resolve(true);
  }),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: sendNotificationMock,
}));

// Mock the Tauri core invoker: `notify_message` records the same title/body a
// `sendNotification` call used to.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { title: string; body: string }) => {
    if (cmd === "notify_message") sendNotificationMock({ title: args.title, body: args.body });
    return Promise.resolve();
  }),
}));

// Mock the Tauri event API: no native host in the test env, so a subscription
// simply never delivers.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
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
    // Coalescing state is module-level and keyed by channel id; clear it so a
    // burst test cannot suppress the next test's single message.
    resetNotificationCoalescing();

    // These cases describe the pre-level behaviour (every non-active message
    // notifies), i.e. the "All" level. The level's own default and gate are
    // covered by notification-level.test.ts and the level cases below.
    testPrefs.set("notificationLevel", "all");

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
      categories: [],
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
            isPrivate: false,
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

    // A channel marked detached by one test (viewing a back-history
    // around-window) must not leak into another that expects the plain
    // active-channel suppression.
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set() }));

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

  it("makes no sound and no OS toast for a call log row", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    mockOscillator.start.mockClear();
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("notificationSounds", true);
    notifyIncomingMessage(
      makePayload({
        kind: "call",
        call: { started_at: "2026-03-15 10:00:00", ended_at: null, participants: [2] },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(mockOscillator.start).not.toHaveBeenCalled();
  });

  it.each([
    "group_add",
    "group_remove",
    "group_leave",
    "group_rename",
    "group_icon",
    "group_future",
  ])("makes no sound and no OS toast for a %s row", async (kind) => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    mockOscillator.start.mockClear();
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("notificationSounds", true);
    notifyIncomingMessage(makePayload({ kind, group_event: { target_user_id: 2 } }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(mockOscillator.start).not.toHaveBeenCalled();
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

  it("with document.hasFocus() true and a message in a non-active channel, no OS notification and no taskbar flash fire", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
    mockOscillator.start.mockClear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", true);
    testPrefs.set("notificationSounds", true);
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(win.requestUserAttention).not.toHaveBeenCalled();
    // D3 (b), Discord desktop: the chime still plays while focused.
    expect(mockOscillator.start).toHaveBeenCalled();
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

  it("role mention notifies a holder", async () => {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    (sendNotification as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("notificationLevel", "mentions");
    authStore.setState((prev) => ({
      ...prev,
      user: prev.user === null ? null : { ...prev.user, role_ids: [5] },
    }));
    // A non-holder's role: the "mentions only" level stays silent.
    notifyIncomingMessage(makePayload({ id: 10, content: "hey <@&6>" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    // A typed token the server did not list stays silent.
    notifyIncomingMessage(makePayload({ id: 11, content: "hey <@&5>" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    // A held role the server lists notifies.
    notifyIncomingMessage(makePayload({ id: 12, content: "hey team", mention_roles: [5] }));
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledTimes(1);
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

  describe("a blocked author", () => {
    async function alerts() {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("notificationSounds", true);
      return {
        popup: sendNotification as ReturnType<typeof vi.fn>,
        flash: win.requestUserAttention as ReturnType<typeof vi.fn>,
        chime: mockOscillator.start,
      };
    }

    afterEach(() => {
      setBlockedByMe([]);
    });

    for (const level of ["all", "mentions"]) {
      it(`raises no popup, flash or chime for a group DM message at the ${level} level`, async () => {
        const a = await alerts();
        testPrefs.set("notificationLevel", level);
        dmStore.setState(() => ({
          channels: [
            {
              channelId: 7,
              recipient: { id: 2, username: "TestUser", avatar: null, status: "online" },
              lastMessageId: null,
              lastMessage: "",
              lastMessageAt: "",
              unreadCount: 0,
              mentionCount: 0,
              isGroup: true,
              members: [],
            } as unknown as DmChannel,
          ],
        }));
        setBlockedByMe([2]);
        notifyIncomingMessage(
          makePayload({ channel_id: 7, content: "hi @everyone", mentions_everyone: true }),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(a.popup).not.toHaveBeenCalled();
        expect(a.flash).not.toHaveBeenCalled();
        expect(a.chime).not.toHaveBeenCalled();
      });
    }

    it("raises nothing in the active channel while the window is away", async () => {
      const a = await alerts();
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      setBlockedByMe([2]);
      notifyIncomingMessage(makePayload({ channel_id: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(a.popup).not.toHaveBeenCalled();
      expect(a.flash).not.toHaveBeenCalled();
      expect(a.chime).not.toHaveBeenCalled();
    });

    it("unblocking restores the alerts", async () => {
      const a = await alerts();
      setBlockedByMe([2]);
      notifyIncomingMessage(makePayload({ channel_id: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      expect(a.popup).not.toHaveBeenCalled();

      setBlockedByMe([]);
      resetNotificationCoalescing();
      notifyIncomingMessage(makePayload({ channel_id: 1 }));
      await vi.waitFor(() => expect(a.popup).toHaveBeenCalled());
      expect(a.chime).toHaveBeenCalled();
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
    setLogLevel("debug");

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
      // The catch now logs the cause. serializeData() turns an Error into
      // { error, stack }, so asserting on it proves the reason reached the
      // log rather than being swallowed — which is the point of the change.
      expect.objectContaining({ error: expect.any(String) }),
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
    setLogLevel("debug");

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
      // The catch now logs the cause. serializeData() turns an Error into
      // { error, stack }, so asserting on it proves the reason reached the
      // log rather than being swallowed — which is the point of the change.
      expect.objectContaining({ error: expect.any(String) }),
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
    setLogLevel("debug");

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
      // The catch now logs the cause. serializeData() turns an Error into
      // { error, stack }, so asserting on it proves the reason reached the
      // log rather than being swallowed — which is the point of the change.
      expect.objectContaining({ error: expect.any(String) }),
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
    // (lib/text/formatting.ts) prefers the live membersStore copy of the
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

    it("suppresses popup and flash when window focused but channel DIFFERS (D3)", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ channel_id: 1 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
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

    // OC-0204: "active channel" is not the same thing as "the user is
    // watching the live tail". A jump to an old permalink/reply/search hit
    // in the active channel opens a detached around-window (messages.store's
    // detachedChannels) — addMessage refuses to append a live broadcast onto
    // it, and dispatcher.ts skips the unread bump because the channel is
    // "active". If this guard also suppresses the notification, an @mention
    // that arrives while the user reads back-history reaches them through
    // literally nothing — not even a popup — even though the window is
    // focused and they are looking at #general.
    it("proceeds when window focused AND channel matches BUT the window is detached (reading back-history)", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([1]) }));

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
      // Imported for its module-load effect only; this test never uses the binding.
      await import("@tauri-apps/api/window");
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
    it("suppresses the desktop notification, the sound and the taskbar flash while DND", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const win = getCurrentWindow();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();

      testPrefs.set("desktopNotifications", true);
      testPrefs.set("notificationSounds", true);
      testPrefs.set("flashTaskbar", true);
      testPrefs.set("userStatus", "dnd");

      notifyIncomingMessage(makePayload());
      notifyIncomingMessage(makePayload({ content: "hi @Me", mentions: [1], id: 2 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(win.requestUserAttention).not.toHaveBeenCalled();
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

  describe("notification level (U1b)", () => {
    it("Nothing silences the popup, the chime and the taskbar flash even for a mention", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();
      testPrefs.set("notificationLevel", "nothing");

      notifyIncomingMessage(
        makePayload({ content: "hey @Me", mentions: [1], mentions_everyone: false }),
      );

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    const bobDm = (): void =>
      dmStore.setState(() => ({
        channels: [
          {
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
          },
        ],
      }));

    it("Nothing does not silence a DM; a server channel message stays silent", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("notificationLevel", "nothing");
      bobDm();

      notifyIncomingMessage(makePayload({ content: "plain channel chatter" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();

      notifyIncomingMessage(
        makePayload({
          channel_id: 55,
          content: "hey",
          user: { id: 2, username: "bob", avatar: null },
        }),
      );
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("Nothing: a muted DM stays silent (the mute still applies)", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("notificationLevel", "nothing");
      bobDm();
      setChannelMutesHost("a.example");
      muteChannel(55);

      try {
        notifyIncomingMessage(
          makePayload({
            channel_id: 55,
            content: "hey",
            user: { id: 2, username: "bob", avatar: null },
          }),
        );
        await new Promise((r) => setTimeout(r, 50));
        expect(sendNotification).not.toHaveBeenCalled();
      } finally {
        unmuteChannel(55);
        setChannelMutesHost(null);
      }
    });

    it("Nothing + Do Not Disturb: a DM shows no popup and plays no chime", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();
      testPrefs.set("notificationLevel", "nothing");
      testPrefs.set("userStatus", "dnd");
      bobDm();

      notifyIncomingMessage(
        makePayload({
          channel_id: 55,
          content: "hey",
          user: { id: 2, username: "bob", avatar: null },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("Mentions only suppresses a plain message but not one that names you", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("notificationLevel", "mentions");

      notifyIncomingMessage(makePayload({ content: "just chatter", mentions: [] }));
      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();

      notifyIncomingMessage(
        makePayload({ content: "hey @Me", mentions: [1], mentions_everyone: false }),
      );
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("treats a DM as addressed to you at Mentions only", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("notificationLevel", "mentions");
      dmStore.setState(() => ({
        channels: [
          {
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
          },
        ],
      }));

      notifyIncomingMessage(
        makePayload({
          channel_id: 55,
          content: "hey",
          user: { id: 2, username: "bob", avatar: null },
        }),
      );

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("notification coalescing (U1c)", () => {
    // Messages in a burst arrive at slightly different times, so each test
    // awaits the previous notification's async chain before sending the next
    // (two concurrent dynamic imports of the mocked notifier in one tick do not
    // both resolve under vitest). Date.now is mocked, so this costs no window.
    it("collapses a burst of channel messages into one popup", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      notifyIncomingMessage(makePayload({ id: 1, content: "one" }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(1_000_100);
      notifyIncomingMessage(makePayload({ id: 2, content: "two" }));
      now.mockReturnValue(1_000_200);
      notifyIncomingMessage(makePayload({ id: 3, content: "three" }));

      await new Promise((r) => setTimeout(r, 20));
      expect(sendNotification).toHaveBeenCalledTimes(1);
      now.mockRestore();
    });

    it("notifies again once the coalescing window has passed", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      notifyIncomingMessage(makePayload({ id: 1 }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(1_000_000 + 6000);
      notifyIncomingMessage(makePayload({ id: 2 }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(2);
      });
      now.mockRestore();
    });

    it("always lets a mention through a burst", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      notifyIncomingMessage(makePayload({ id: 1, content: "chatter" }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(1_000_100);
      notifyIncomingMessage(
        makePayload({ id: 2, content: "hey @Me", mentions: [1], mentions_everyone: false }),
      );
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(2);
      });
      now.mockRestore();
    });

    it("collapses a burst of direct messages like any channel", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      dmStore.setState(() => ({
        channels: [
          {
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
          },
        ],
      }));
      const dm = (id: number) =>
        makePayload({ id, channel_id: 55, user: { id: 2, username: "bob", avatar: null } });

      notifyIncomingMessage(dm(1));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(1_000_100);
      notifyIncomingMessage(dm(2));
      now.mockReturnValue(1_000_200);
      notifyIncomingMessage(dm(3));

      await new Promise((r) => setTimeout(r, 20));
      expect(sendNotification).toHaveBeenCalledTimes(1);
      now.mockRestore();
    });

    it("coalesces per channel, not globally", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

      notifyIncomingMessage(makePayload({ id: 1, channel_id: 1 }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockReturnValue(1_000_100);
      notifyIncomingMessage(makePayload({ id: 2, channel_id: 2 }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(2);
      });
      now.mockRestore();
    });

    it("a message that raised no alert does not start the window", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      testPrefs.set("notificationSounds", false);
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));

      notifyIncomingMessage(makePayload({ id: 1, channel_id: 1 }));
      await new Promise((r) => setTimeout(r, 20));
      expect(sendNotification).not.toHaveBeenCalled();

      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      now.mockReturnValue(1_003_000);
      notifyIncomingMessage(makePayload({ id: 2, channel_id: 1 }));
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalledTimes(1);
      });
      now.mockRestore();
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

  describe("click-to-open (U1d)", () => {
    it("shows the message notification with the channel and message it points at", async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      (invoke as ReturnType<typeof vi.fn>).mockClear();
      testPrefs.set("desktopNotifications", true);
      testPrefs.set("flashTaskbar", false);
      testPrefs.set("notificationSounds", false);

      notifyIncomingMessage(makePayload({ id: 42, channel_id: 7 }));

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          "notify_message",
          expect.objectContaining({ channelId: 7, messageId: 42 }),
        );
      });
    });

    it.each([
      ["opens the message", "a.example", [[7, 42]]],
      ["ignores a click once signed into another server", "b.example", []],
    ])(
      "falls back to the Web Notification API, whose click %s",
      async (_name, hostAtClick, expectedJumps) => {
        const { invoke } = await import("@tauri-apps/api/core");
        (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("no native host"));
        const shown: EventTarget[] = [];
        const mockWebNotification = vi.fn(function () {
          const popup = new EventTarget();
          shown.push(popup);
          return popup;
        });
        const originalNotification = globalThis.Notification;
        (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
          permission: "granted",
          requestPermission: vi.fn(),
        });
        const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
        const jump = vi.fn();
        const unregister = setMessageJumpHandler(jump);
        setChannelMutesHost("a.example");
        testPrefs.set("desktopNotifications", true);
        testPrefs.set("flashTaskbar", false);
        testPrefs.set("notificationSounds", false);

        try {
          notifyIncomingMessage(makePayload({ id: 42, channel_id: 7 }));

          await vi.waitFor(() => {
            expect(shown).toHaveLength(1);
          });
          setChannelMutesHost(hostAtClick);
          shown[0]!.dispatchEvent(new Event("click"));

          expect(focus).toHaveBeenCalledOnce();
          expect(jump.mock.calls).toEqual(expectedJumps);
        } finally {
          focus.mockRestore();
          unregister();
          setChannelMutesHost(null);
          (globalThis as Record<string, unknown>).Notification = originalNotification;
        }
      },
    );
  });

  describe("notifyMention", () => {
    async function spies() {
      const { invoke } = await import("@tauri-apps/api/core");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (invoke as ReturnType<typeof vi.fn>).mockClear();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();
      return { invoke: invoke as ReturnType<typeof vi.fn>, win };
    }

    it("Nothing silences the popup, the chime and the flash", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("notificationLevel", "nothing");

      notifyMention(1);

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("Mentions only shows the popup, titled with the channel and targeting it", async () => {
      const { invoke } = await spies();
      testPrefs.set("notificationLevel", "mentions");
      setChannelMutesHost("a.example");

      try {
        notifyMention(1);

        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith("notify_message", {
            title: "You were mentioned in #general",
            body: "",
            host: "a.example",
            channelId: 1,
            messageId: undefined,
          });
        });
      } finally {
        setChannelMutesHost(null);
      }
    });

    it("chimes only while the window is focused on another channel", async () => {
      const { invoke, win } = await spies();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 99 }));

      notifyMention(1);

      await vi.waitFor(() => {
        expect(mockOscillator.start).toHaveBeenCalled();
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("does nothing for the channel on screen while focused", async () => {
      const { invoke, win } = await spies();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);

      notifyMention(1);

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("Do Not Disturb suppresses the popup, the chime and the taskbar flash", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("userStatus", "dnd");

      notifyMention(1);

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("stays silent while Suppress @everyone is on", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("suppressEveryone", true);

      try {
        notifyMention(1);

        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();
        expect(mockOscillator.start).not.toHaveBeenCalled();
        expect(win.requestUserAttention).not.toHaveBeenCalled();
      } finally {
        testPrefs.set("suppressEveryone", false);
      }
    });

    it("passes a channel mute", async () => {
      const { invoke } = await spies();
      muteChannel(1);

      try {
        notifyMention(1);

        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            "notify_message",
            expect.objectContaining({ title: "You were mentioned in #general", channelId: 1 }),
          );
        });
      } finally {
        unmuteChannel(1);
      }
    });

    it("skips a DM", async () => {
      const { invoke } = await spies();
      dmStore.setState(() => ({
        channels: [
          {
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
          },
        ],
      }));

      notifyMention(55);

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });
  });

  describe("notifyChannelActivity", () => {
    function entry(
      flags: Partial<{
        message_id: number;
        author_id: number;
        mentions_you: boolean;
        mentions_everyone: boolean;
      }> = {},
    ): ChannelActivityEntry {
      return {
        channel_id: 1,
        message_id: 42,
        author_id: 2,
        mentions_you: false,
        mentions_everyone: false,
        ...flags,
      };
    }

    async function spies() {
      const { invoke } = await import("@tauri-apps/api/core");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      (invoke as ReturnType<typeof vi.fn>).mockClear();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();
      return { invoke: invoke as ReturnType<typeof vi.fn>, win };
    }

    beforeEach(() => {
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
        roleRevision: 0,
      }));
      setBlockedByMe([]);
    });

    it("All level names the author and opens the message", async () => {
      const { invoke } = await spies();

      notifyChannelActivity(entry());

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("notify_message", {
          title: "Alice in #general",
          body: "",
          host: "",
          channelId: 1,
          messageId: 42,
        });
      });
    });

    it("an entry without an author is titled by its channel", async () => {
      const { invoke } = await spies();

      notifyChannelActivity(entry({ author_id: undefined }));

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          "notify_message",
          expect.objectContaining({ title: "New message in #general", messageId: 42 }),
        );
      });
    });

    it("Mentions only skips a plain message and announces a direct mention", async () => {
      const { invoke } = await spies();
      testPrefs.set("notificationLevel", "mentions");

      notifyChannelActivity(entry());
      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();

      notifyChannelActivity(entry({ message_id: 43, mentions_you: true }));
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          "notify_message",
          expect.objectContaining({ title: "Alice mentioned you in #general", messageId: 43 }),
        );
      });
    });

    it("Suppress @everyone drops an @everyone-only alert but keeps a direct mention", async () => {
      const { invoke } = await spies();
      testPrefs.set("notificationLevel", "mentions");
      testPrefs.set("suppressEveryone", true);

      notifyChannelActivity(entry({ mentions_everyone: true }));
      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();

      notifyChannelActivity(entry({ message_id: 43, mentions_you: true, mentions_everyone: true }));
      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledWith(
          "notify_message",
          expect.objectContaining({ title: "Alice mentioned you in #general" }),
        );
      });
    });

    it("never alerts for the reader's own message or a blocked author", async () => {
      const { invoke } = await spies();
      setBlockedByMe([2]);

      notifyChannelActivity(entry({ author_id: 1 }));
      notifyChannelActivity(entry({ mentions_you: true }));

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("folds a burst in one channel into one alert", async () => {
      const { invoke } = await spies();

      notifyChannelActivity(entry());
      notifyChannelActivity(entry({ message_id: 43 }));

      await vi.waitFor(() => {
        expect(invoke).toHaveBeenCalledTimes(1);
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    describe("a followed thread", () => {
      const thread = { parentId: 1, name: "Release plan", watching: false };
      beforeEach(() => setChannelMutesHost("thread.test"));
      afterEach(() => unmuteChannel(1));
      const threadEntry = (flags: Partial<ChannelActivityEntry> = {}): ChannelActivityEntry =>
        entry({ ...flags, channel_id: 91 } as never);

      it("is titled '#parent › thread' and opens the parent channel", async () => {
        const { invoke } = await spies();

        notifyChannelActivity(threadEntry(), thread);

        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            "notify_message",
            expect.objectContaining({
              title: "Alice in #general › Release plan",
              channelId: 1,
            }),
          );
        });
      });

      it("notifies a plain message only when the parent's level is All", async () => {
        const { invoke } = await spies();
        testPrefs.set("notificationLevel", "mentions");

        notifyChannelActivity(threadEntry(), thread);
        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();

        // The parent's own override decides, not a level for the thread id.
        testPrefs.set("channelNotificationLevels:thread.test", { 1: "all" });
        notifyChannelActivity(threadEntry({ message_id: 43 }), thread);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      });

      it("takes the parent's Nothing level, which silences even a mention", async () => {
        const { invoke } = await spies();
        testPrefs.set("channelNotificationLevels:thread.test", { 1: "nothing" });

        notifyChannelActivity(threadEntry({ mentions_you: true }), thread);
        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();
      });

      it("takes the parent's mute for a plain message but lets a mention through", async () => {
        const { invoke } = await spies();
        muteChannel(1);

        notifyChannelActivity(threadEntry(), thread);
        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();

        notifyChannelActivity(threadEntry({ message_id: 43, mentions_you: true }), thread);
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
        unmuteChannel(1);
      });

      it("stays quiet while the reader has the thread open", async () => {
        const { invoke } = await spies();
        vi.spyOn(document, "hasFocus").mockReturnValue(true);

        notifyChannelActivity(threadEntry({ mentions_you: true }), { ...thread, watching: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();
      });

      it("titles a mention alert for the thread with its parent's name", async () => {
        const { invoke } = await spies();

        notifyMention(91, thread);

        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            "notify_message",
            expect.objectContaining({
              title: "You were mentioned in #general › Release plan",
              channelId: 1,
            }),
          );
        });
      });
    });

    it("chimes only while the window is focused on another channel", async () => {
      const { invoke, win } = await spies();
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 99 }));

      notifyChannelActivity(entry());

      await vi.waitFor(() => {
        expect(mockOscillator.start).toHaveBeenCalled();
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("a muted channel stays silent unless the entry mentions the reader", async () => {
      const { invoke } = await spies();
      muteChannel(1);

      try {
        notifyChannelActivity(entry());
        await new Promise((r) => setTimeout(r, 50));
        expect(invoke).not.toHaveBeenCalled();

        notifyChannelActivity(entry({ message_id: 43, mentions_you: true }));
        await vi.waitFor(() => {
          expect(invoke).toHaveBeenCalledWith(
            "notify_message",
            expect.objectContaining({ title: "Alice mentioned you in #general" }),
          );
        });
      } finally {
        unmuteChannel(1);
      }
    });

    it("Do Not Disturb suppresses the popup and the chime", async () => {
      const { invoke } = await spies();
      testPrefs.set("userStatus", "dnd");

      notifyChannelActivity(entry({ mentions_you: true }));

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("Nothing silences the popup, the chime and the flash", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("notificationLevel", "nothing");

      notifyChannelActivity(entry({ mentions_you: true }));

      await new Promise((r) => setTimeout(r, 50));
      expect(invoke).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });
  });

  describe("openMessageTarget (the shared deep-link / notification guard)", () => {
    it("opens a target that named the signed-in server", () => {
      const jump = vi.fn();
      const unregister = setMessageJumpHandler(jump);
      setChannelMutesHost("a.example");
      try {
        openMessageTarget(7, 42, "a.example");
        expect(jump.mock.calls).toEqual([[7, 42]]);
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });

    it("opens a link that named no server — a permalink pasted into chat", () => {
      const jump = vi.fn();
      const unregister = setMessageJumpHandler(jump);
      setChannelMutesHost("a.example");
      try {
        openMessageTarget(7, 42);
        expect(jump.mock.calls).toEqual([[7, 42]]);
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });

    it("ignores a target that named another server", () => {
      const jump = vi.fn();
      const unregister = setMessageJumpHandler(jump);
      setChannelMutesHost("b.example");
      try {
        openMessageTarget(7, 42, "a.example");
        expect(jump).not.toHaveBeenCalled();
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });

    // DP-24: a call notification's target has no message id. It goes through
    // the same guard: opened on its own server, dropped from another one.
    it("opens a call target (no message) on its own server and drops one from another", () => {
      const jump = vi.fn();
      const unregister = setMessageJumpHandler(jump);
      try {
        setChannelMutesHost("a.example");
        openMessageTarget(7, undefined, "a.example");
        setChannelMutesHost("b.example");
        openMessageTarget(7, undefined, "a.example");
        expect(jump.mock.calls).toEqual([[7, undefined]]);
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });

    it("buffers a cold-start target until a jumper is registered, then opens it once the page is live (F6)", async () => {
      // A Windows toast activated from Action Center launches the app before
      // any MainPage registers the jumper and sets the host.
      setChannelMutesHost(null);
      openMessageTarget(7, 42, "a.example");

      // MainPage mounts: host now known, then the jumper registers — before
      // the rest of the synchronous mount creates the channel controller the
      // jump needs.
      setChannelMutesHost("a.example");
      let pageLive = false;
      const jump = vi.fn(() => pageLive);
      const unregister = setMessageJumpHandler(jump);
      pageLive = true;
      try {
        await Promise.resolve();
        expect(jump.mock.calls).toEqual([[7, 42]]);
        expect(jump.mock.results[0]?.value).toBe(true);
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });

    it("drops a buffered cold-start target that names another server (F6)", async () => {
      setChannelMutesHost(null);
      openMessageTarget(7, 42, "a.example");

      setChannelMutesHost("b.example");
      const jump = vi.fn();
      const unregister = setMessageJumpHandler(jump);
      try {
        await Promise.resolve();
        expect(jump).not.toHaveBeenCalled();
      } finally {
        unregister();
        setChannelMutesHost(null);
      }
    });
  });

  describe("per-channel level", () => {
    const HOST = "level.example";
    const mention = { content: "hey @Me", mentions: [1], mentions_everyone: false };

    /** Every channel on this server's alert surfaces, counted together. */
    async function alerts(): Promise<{ count: () => number; clear: () => void }> {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { invoke } = await import("@tauri-apps/api/core");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const clear = (): void => {
        (sendNotification as ReturnType<typeof vi.fn>).mockClear();
        (invoke as ReturnType<typeof vi.fn>).mockClear();
        (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
        mockOscillator.start.mockClear();
      };
      clear();
      return {
        clear,
        count: () =>
          (sendNotification as ReturnType<typeof vi.fn>).mock.calls.length +
          (invoke as ReturnType<typeof vi.fn>).mock.calls.length +
          (win.requestUserAttention as ReturnType<typeof vi.fn>).mock.calls.length +
          mockOscillator.start.mock.calls.length,
      };
    }

    const setOverride = (level: string): void => {
      testPrefs.set(`channelNotificationLevels:${HOST}`, { "1": level });
    };

    beforeEach(() => {
      setChannelMutesHost(HOST);
      vi.spyOn(document, "hasFocus").mockReturnValue(false);
    });
    afterEach(() => {
      setChannelMutesHost(null);
    });

    it("a channel at Nothing silences a mention in all three notify paths", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "all");
      setOverride("nothing");

      notifyIncomingMessage(makePayload(mention));
      notifyMention(1);
      notifyChannelActivity({
        channel_id: 1,
        message_id: 42,
        author_id: 2,
        mentions_you: true,
        mentions_everyone: false,
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(seen.count()).toBe(0);
    });

    it("a channel at All notifies in a server at Nothing", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "nothing");
      setOverride("all");

      notifyIncomingMessage(makePayload({ content: "plain" }));

      await vi.waitFor(() => {
        expect(seen.count()).toBeGreaterThan(0);
      });
    });

    it("a channel at Only @mentions drops plain chatter in a server at All", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "all");
      setOverride("mentions");

      notifyIncomingMessage(makePayload({ content: "plain" }));

      await new Promise((r) => setTimeout(r, 50));
      expect(seen.count()).toBe(0);
    });

    it("a channel without an override follows the server level", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "nothing");
      testPrefs.set(`channelNotificationLevels:${HOST}`, { "99": "all" });

      notifyIncomingMessage(makePayload(mention));

      await new Promise((r) => setTimeout(r, 50));
      expect(seen.count()).toBe(0);
    });

    it("a channel at Only @mentions with a mute still notifies a mention", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "nothing");
      setOverride("mentions");
      muteChannel(1);

      try {
        notifyIncomingMessage(makePayload(mention));

        await vi.waitFor(() => {
          expect(seen.count()).toBeGreaterThan(0);
        });
      } finally {
        unmuteChannel(1);
      }
    });

    it("a DM ignores the level, including a stray override on its id", async () => {
      const seen = await alerts();
      testPrefs.set("notificationLevel", "nothing");
      testPrefs.set(`channelNotificationLevels:${HOST}`, { "55": "nothing" });
      dmStore.setState(() => ({
        channels: [
          {
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
          },
        ],
      }));

      notifyIncomingMessage(makePayload({ channel_id: 55, content: "psst" }));

      await vi.waitFor(() => {
        expect(seen.count()).toBeGreaterThan(0);
      });
    });
  });
});
