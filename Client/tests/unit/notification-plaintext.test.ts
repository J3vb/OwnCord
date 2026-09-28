/**
 * U1(a): an OS notification must never leak raw markdown or spoiler-marked
 * text onto a lock screen. `markdownToPlainText` is the one serializer that
 * flattens a message to its visible words, and `notifyIncomingMessage` must
 * route the popup body through it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { markdownToPlainText } from "../../src/lib/markdown";
import { notifyIncomingMessage } from "../../src/lib/notifications";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";

const { testPrefs } = vi.hoisted(() => ({ testPrefs: new Map<string, unknown>() }));

vi.mock("../../src/lib/preferences", () => ({
  STORAGE_PREFIX: "owncord:settings:",
  loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
  savePref: (key: string, value: unknown) => testPrefs.set(key, value),
}));

vi.mock("../../src/lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));

// The native path shows a message notification through the host's
// `notify_message` command (so a click can open it); this records the args.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn().mockReturnValue({ requestUserAttention: vi.fn() }),
}));

describe("markdownToPlainText", () => {
  it("replaces a spoiler with a label and never leaks its hidden text", () => {
    const out = markdownToPlainText("the answer is ||forty-two|| ok", "Spoiler");
    expect(out).not.toContain("forty-two");
    expect(out).not.toContain("||");
    expect(out).toBe("the answer is Spoiler ok");
  });

  it("drops inline style markers but keeps the words", () => {
    expect(markdownToPlainText("**bold** *em* __under__ ~~strike~~", "Spoiler")).toBe(
      "bold em under strike",
    );
  });

  it("keeps code content without the backticks", () => {
    expect(markdownToPlainText("try `npm test` now", "Spoiler")).toBe("try npm test now");
  });

  it("shows a masked link's text, not its URL", () => {
    expect(markdownToPlainText("see [the docs](https://example.com/docs)", "Spoiler")).toBe(
      "see the docs",
    );
  });

  it("strips heading, quote and list block markers", () => {
    expect(markdownToPlainText("# Release notes", "Spoiler")).toBe("Release notes");
    expect(markdownToPlainText("> quoted line", "Spoiler")).toBe("quoted line");
    expect(markdownToPlainText("- one\n- two", "Spoiler")).toBe("one two");
  });

  it("strips a fenced code block's fences", () => {
    expect(markdownToPlainText("```js\nconst x = 1;\n```", "Spoiler")).toBe("const x = 1;");
  });

  it("collapses whitespace to a single line", () => {
    expect(markdownToPlainText("hello\n   world", "Spoiler")).toBe("hello world");
  });
});

describe("notifyIncomingMessage — popup body is plain text (U1a)", () => {
  beforeEach(() => {
    testPrefs.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    authStore.setState(() => ({
      token: "t",
      user: { id: 1, username: "Me", avatar: null, role: "member" },
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));
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
      activeChannelId: null,
      roles: [],
    }));
    dmStore.setState(() => ({ channels: [] }));
  });

  it("strips spoilers and markdown from the body", async () => {
    (invokeMock as ReturnType<typeof vi.fn>).mockClear();
    testPrefs.set("desktopNotifications", true);
    testPrefs.set("flashTaskbar", false);
    testPrefs.set("notificationSounds", false);
    // The body-serializer case is about content, not the level gate; use All so
    // this non-mention message still fires.
    testPrefs.set("notificationLevel", "all");

    notifyIncomingMessage({
      id: 1,
      channel_id: 1,
      user: { id: 2, username: "Bob", avatar: null },
      content: "**hi** ||secret|| there",
      reply_to: null,
      attachments: [],
      timestamp: new Date().toISOString(),
    });

    await vi.waitFor(() => {
      const call = invokeMock.mock.calls.find((c) => c[0] === "notify_message")![1] as {
        body: string;
      };
      expect(call.body).toBe("hi Spoiler there");
    });
  });
});
