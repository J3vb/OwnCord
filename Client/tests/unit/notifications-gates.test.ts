/**
 * Which of the three alerts (popup, taskbar flash, chime) each notification
 * entry point raises, under every preference and focus combination. Each case
 * waits for the asynchronous popup path to settle before asserting that
 * something did NOT happen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyChannelActivity,
  notifyIncomingMessage,
  notifyMention,
  resetNotificationCoalescing,
} from "../../src/lib/notifications";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import { messagesStore } from "../../src/stores/messages.store";
import { setBlockedByMe } from "../../src/stores/blocks.store";
import { addLogListener, setLogLevel, type LogEntry } from "../../src/lib/logger";
import type { ChannelActivityEntry, ChatMessagePayload } from "../../src/lib/types";

const { testPrefs, shouldTauriNotifThrow, sendNotificationMock } = vi.hoisted(() => ({
  testPrefs: new Map<string, unknown>(),
  shouldTauriNotifThrow: { value: false },
  sendNotificationMock: vi.fn(),
}));

vi.mock("../../src/lib/prefs/preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));
vi.mock("../../src/lib/voice/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => {
    if (shouldTauriNotifThrow.value) throw new Error("Tauri not available");
    return Promise.resolve(true);
  }),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: sendNotificationMock,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: { title: string; body: string }) => {
    if (cmd === "notify_message") sendNotificationMock({ title: args.title, body: args.body });
    return Promise.resolve();
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    requestUserAttention: vi.fn().mockResolvedValue(undefined),
  }),
}));

const oscillator = {
  connect: vi.fn(),
  frequency: { setValueAtTime: vi.fn() },
  start: vi.fn(),
  stop: vi.fn(),
};
const gain = {
  connect: vi.fn(),
  gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
};
class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    return oscillator;
  }
  createGain() {
    return gain;
  }
  close() {
    return Promise.resolve();
  }
}
(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

// The popup body loads the markdown tokenizer lazily; load it once up front so
// the first case is not slower than the rest.
await import("../../src/lib/text/markdown");
const { invoke } = await import("@tauri-apps/api/core");
const { getCurrentWindow } = await import("@tauri-apps/api/window");
const flashSpy = getCurrentWindow().requestUserAttention as ReturnType<typeof vi.fn>;
const popupSpy = invoke as ReturnType<typeof vi.fn>;

function activity(flags: Partial<ChannelActivityEntry> = {}): ChannelActivityEntry {
  return {
    channel_id: 1,
    message_id: 42,
    author_id: 2,
    mentions_you: false,
    mentions_everyone: false,
    ...flags,
  };
}

function message(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
  return {
    id: 7,
    channel_id: 1,
    user: { id: 2, username: "TestUser", avatar: null },
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

interface Alerts {
  readonly popups: number;
  readonly flashes: number;
  readonly chimes: number;
}

/** Waits for the asynchronous popup path, then counts what was raised. */
async function alerts(): Promise<Alerts> {
  await new Promise((resolve) => setTimeout(resolve, 40));
  return {
    popups: popupSpy.mock.calls.filter((call) => call[0] === "notify_message").length,
    flashes: flashSpy.mock.calls.length,
    chimes: oscillator.start.mock.calls.length,
  };
}

const ALL: Alerts = { popups: 1, flashes: 1, chimes: 1 };
const NONE: Alerts = { popups: 0, flashes: 0, chimes: 0 };

type EntryPoint = readonly [string, () => void];
const ENTRY_POINTS: readonly EntryPoint[] = [
  ["a mention in an unwatched channel", () => notifyMention(1)],
  ["a channel activity entry", () => notifyChannelActivity(activity())],
];

function dmChannel(channelId: number) {
  const user = { id: 2, username: "bob", avatar: "", status: "online" };
  return {
    channelId,
    recipient: user,
    participants: [user],
    name: "",
    isGroup: false,
    lastMessageId: null,
    lastMessage: "",
    lastMessageAt: "",
    unreadCount: 0,
    mentionCount: 0,
  };
}

let hasFocus: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  testPrefs.clear();
  testPrefs.set("notificationLevel", "all");
  resetNotificationCoalescing();
  popupSpy.mockClear();
  flashSpy.mockClear();
  oscillator.start.mockClear();
  shouldTauriNotifThrow.value = false;
  authStore.setState(() => ({
    token: "test",
    user: { id: 1, username: "Me", avatar: null, role: "member" },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
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
  dmStore.setState(() => ({ channels: [] }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
    roleRevision: 0,
  }));
  messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set() }));
  setBlockedByMe([]);
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("warn");
});

describe.each(ENTRY_POINTS)("%s", (_name, fire) => {
  it("raises the popup, the flash and the chime when no preference is set", async () => {
    fire();
    expect(await alerts()).toEqual(ALL);
  });

  it("drops only the popup when desktop notifications are off", async () => {
    testPrefs.set("desktopNotifications", false);
    fire();
    expect(await alerts()).toEqual({ popups: 0, flashes: 1, chimes: 1 });
  });

  it("drops only the flash when the taskbar flash is off", async () => {
    testPrefs.set("flashTaskbar", false);
    fire();
    expect(await alerts()).toEqual({ popups: 1, flashes: 0, chimes: 1 });
  });

  it("drops only the chime when notification sounds are off", async () => {
    testPrefs.set("notificationSounds", false);
    fire();
    expect(await alerts()).toEqual({ popups: 1, flashes: 1, chimes: 0 });
  });

  it("raises the popup alone when the flash and the sounds are off", async () => {
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);
    fire();
    expect(await alerts()).toEqual({ popups: 1, flashes: 0, chimes: 0 });
  });

  it("raises the flash alone when the popup and the sounds are off", async () => {
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("notificationSounds", false);
    fire();
    expect(await alerts()).toEqual({ popups: 0, flashes: 1, chimes: 0 });
  });

  it("raises nothing when all three are off", async () => {
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);
    fire();
    expect(await alerts()).toEqual(NONE);
  });

  it("only chimes while the window is focused on another channel", async () => {
    hasFocus.mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 99 }));
    fire();
    expect(await alerts()).toEqual({ popups: 0, flashes: 0, chimes: 1 });
  });

  it("raises nothing for the channel the focused window is showing", async () => {
    hasFocus.mockReturnValue(true);
    fire();
    expect(await alerts()).toEqual(NONE);
  });

  it("alerts for the focused channel when a jump left it detached from the live tail", async () => {
    hasFocus.mockReturnValue(true);
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([1]) }));
    fire();
    expect(await alerts()).toEqual(ALL);
  });

  it("raises nothing under Do Not Disturb", async () => {
    testPrefs.set("userStatus", "dnd");
    fire();
    expect(await alerts()).toEqual(NONE);
  });

  it("raises nothing for a direct message conversation", async () => {
    dmStore.setState(() => ({ channels: [dmChannel(1)] }));
    fire();
    expect(await alerts()).toEqual(NONE);
  });
});

const threadEntry = (): ChannelActivityEntry => activity({ channel_id: 91 });

describe("a followed thread", () => {
  const thread = { parentId: 1, name: "Release plan", watching: false };

  it("stays quiet while the reader has it open, even if its own id counts as detached", async () => {
    hasFocus.mockReturnValue(true);
    messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([91]) }));
    notifyChannelActivity(threadEntry(), { ...thread, watching: true });
    expect(await alerts()).toEqual(NONE);
  });

  it("only chimes while the reader has a different thread open", async () => {
    hasFocus.mockReturnValue(true);
    notifyChannelActivity(threadEntry(), thread);
    expect(await alerts()).toEqual({ popups: 0, flashes: 0, chimes: 1 });
  });

  it("alerts fully when nothing is focused", async () => {
    notifyChannelActivity(threadEntry(), thread);
    expect(await alerts()).toEqual(ALL);
  });
});

describe("notifyChannelActivity filters", () => {
  it("still alerts for a plain message while Suppress @everyone is on", async () => {
    testPrefs.set("suppressEveryone", true);
    notifyChannelActivity(activity());
    expect(await alerts()).toEqual(ALL);
  });

  it("alerts for an @everyone message when Suppress @everyone is not set", async () => {
    notifyChannelActivity(activity({ mentions_everyone: true }));
    expect(await alerts()).toEqual(ALL);
  });

  it("drops an @everyone message when Suppress @everyone is on", async () => {
    testPrefs.set("suppressEveryone", true);
    notifyChannelActivity(activity({ mentions_everyone: true }));
    expect(await alerts()).toEqual(NONE);
  });

  it("folds a second plain message into the first alert but always announces a mention", async () => {
    notifyChannelActivity(activity());
    notifyChannelActivity(activity({ message_id: 43 }));
    expect(await alerts()).toEqual(ALL);

    notifyChannelActivity(activity({ message_id: 44, mentions_you: true }));
    expect(await alerts()).toEqual({ popups: 2, flashes: 2, chimes: 2 });
  });

  it("does not let a muted-out popup that was never shown start a coalescing window", async () => {
    testPrefs.set("desktopNotifications", false);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);
    notifyChannelActivity(activity());
    expect(await alerts()).toEqual(NONE);

    testPrefs.clear();
    testPrefs.set("notificationLevel", "all");
    notifyChannelActivity(activity({ message_id: 43 }));
    expect(await alerts()).toEqual(ALL);
  });
});

describe("notification coalescing window", () => {
  it("folds messages inside five seconds and announces again at exactly five", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    notifyChannelActivity(activity());
    expect((await alerts()).popups).toBe(1);

    now.mockReturnValue(1_004_999);
    notifyChannelActivity(activity({ message_id: 43 }));
    expect((await alerts()).popups).toBe(1);

    now.mockReturnValue(1_005_000);
    notifyChannelActivity(activity({ message_id: 44 }));
    expect((await alerts()).popups).toBe(2);
  });

  it("measures the window from the last alert that was shown", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(2_000_000);
    notifyIncomingMessage(message({ id: 1 }));
    expect((await alerts()).popups).toBe(1);

    now.mockReturnValue(2_003_000);
    notifyIncomingMessage(message({ id: 2 }));
    expect((await alerts()).popups).toBe(1);

    now.mockReturnValue(2_006_000);
    notifyIncomingMessage(message({ id: 3 }));
    expect((await alerts()).popups).toBe(2);
  });
});

describe("notifyIncomingMessage defaults", () => {
  it("flashes the taskbar when the preference was never set", async () => {
    notifyIncomingMessage(message());
    expect(await alerts()).toEqual(ALL);
  });
});

async function bodyOf(payload: ChatMessagePayload): Promise<string> {
  notifyIncomingMessage(payload);
  await alerts();
  return String(sendNotificationMock.mock.calls.at(-1)?.[0]?.body);
}

describe("popup bodies", () => {
  it("shows the words of a message even when it also carries attachments", async () => {
    const attachments = [{ id: 1 }, { id: 2 }] as unknown as ChatMessagePayload["attachments"];
    expect(await bodyOf(message({ content: "look at these", attachments }))).toBe("look at these");
  });

  it("counts the attachments of a message with no words", async () => {
    const attachments = [{ id: 1 }, { id: 2 }] as unknown as ChatMessagePayload["attachments"];
    expect(await bodyOf(message({ content: "", attachments }))).toBe("sent 2 attachments");
  });

  it("leaves the body empty for a message with neither words nor attachments", async () => {
    expect(await bodyOf(message({ content: "" }))).toBe("");
  });
});

function stubNotification(permission: string, requested: string) {
  const shown: Array<{ title: string; options: unknown; popup: EventTarget }> = [];
  const requestPermission = vi.fn().mockResolvedValue(requested);
  const original = globalThis.Notification;
  class FakeNotification extends EventTarget {
    static permission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, options: unknown) {
      super();
      shown.push({ title, options, popup: this });
    }
  }
  (globalThis as Record<string, unknown>).Notification = FakeNotification;
  return {
    shown,
    requestPermission,
    restore: () => {
      (globalThis as Record<string, unknown>).Notification = original;
    },
  };
}

describe("the web notification fallback", () => {
  afterEach(() => {
    shouldTauriNotifThrow.value = false;
  });

  it("asks for permission when it is undecided and shows the popup once granted", async () => {
    shouldTauriNotifThrow.value = true;
    const web = stubNotification("default", "granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    try {
      notifyIncomingMessage(message({ content: "hi there" }));
      await alerts();

      expect(web.requestPermission).toHaveBeenCalledTimes(1);
      expect(web.shown).toHaveLength(1);
      expect(web.shown[0]!.title).toBe("TestUser in #general");
      expect(web.shown[0]!.options).toEqual({ body: "hi there" });
      web.shown[0]!.popup.dispatchEvent(new Event("click"));
      expect(focus).toHaveBeenCalledOnce();
    } finally {
      web.restore();
    }
  });

  it("shows nothing when the user refuses the permission request", async () => {
    shouldTauriNotifThrow.value = true;
    const web = stubNotification("default", "denied");
    try {
      notifyIncomingMessage(message());
      await alerts();
      expect(web.requestPermission).toHaveBeenCalledTimes(1);
      expect(web.shown).toHaveLength(0);
    } finally {
      web.restore();
    }
  });

  it("logs why it fell back from the native notifier", async () => {
    shouldTauriNotifThrow.value = true;
    const web = stubNotification("granted", "granted");
    setLogLevel("debug");
    const entries: LogEntry[] = [];
    const stop = addLogListener((entry) => entries.push(entry));
    try {
      notifyIncomingMessage(message());
      await alerts();
    } finally {
      stop();
      web.restore();
    }
    const fallback = entries.find((e) => e.message.startsWith("Tauri notification plugin"));
    expect(fallback?.message).toBe(
      "Tauri notification plugin unavailable, falling back to Web API",
    );
    expect(fallback?.component).toBe("notifications");
    expect(fallback?.level).toBe("debug");
  });
});
