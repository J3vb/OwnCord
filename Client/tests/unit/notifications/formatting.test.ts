import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/notificationsMocks";
import { notifyIncomingMessage } from "../../../src/lib/notifications";
import { channelsStore } from "../../../src/stores/channels.store";
import { messagesStore } from "../../../src/stores/messages.store";
import { setLogLevel } from "../../../src/lib/logger";
import {
  armDesktopNotifications,
  freshSendNotification,
  armDesktopPrefs,
  makePayload,
  setAlertPrefs,
  notifyAs,
  useNotificationsHarness,
  seedNicknamedMember,
  seedBobDm,
} from "../../helpers/notificationsHarness";
import { resetAuthState } from "../../helpers/storeSeeds";

vi.mock("../../../src/lib/prefs/preferences", (importOriginal) =>
  mocks.prefsPreferencesMock(importOriginal),
);
vi.mock("../../../src/lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@tauri-apps/plugin-notification", () => mocks.pluginNotificationMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@tauri-apps/api/window", () => mocks.apiWindowMock());

const { testPrefs, mockOscillator } = mocks;

// The three tests that assert on the logger's debug lines raise the level the
// global setup lowered (C-04) for themselves; this puts it back.
afterEach(() => {
  setLogLevel("warn");
});

describe("notifyIncomingMessage", () => {
  useNotificationsHarness();

  // =========================================================================
  // Mutation-killing tests: verify exact argument values, boundary conditions,
  // boolean/arithmetic/string mutations.
  // =========================================================================

  describe("sendNotification receives correct title and body", () => {
    it("passes title with format 'username in #channelName'", async () => {
      const sendNotification = await armDesktopNotifications();

      notifyAs("Alice", 1, "Hey there!");

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
      const sendNotification = await freshSendNotification();

      seedBobDm();

      armDesktopPrefs();

      notifyAs("bob", 55, "hey");

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
      const sendNotification = await freshSendNotification();

      seedNicknamedMember(1);

      armDesktopPrefs();

      notifyAs("a_martinez", 1, "hi");

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
      const sendNotification = await armDesktopNotifications();

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
      const sendNotification = await freshSendNotification();

      channelsStore.setState((prev) => ({ ...prev, channels: new Map() }));

      armDesktopPrefs();

      notifyAs("Bob", 42, "test");

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
      const sendNotification = await freshSendNotification();

      // "X in #general" = 13 chars. We need username to make title exactly 80.
      // title = `${username} in #general` => username.length + 12 = 80 => 68
      const username = "U".repeat(68);

      armDesktopPrefs();

      notifyAs(username, 1, "x");

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe(`${"U".repeat(68)} in #general`);
        expect(call.title.length).toBe(80);
        // Should NOT end with "..."
        expect(call.title.endsWith("...")).toBe(false);
      });
    });

    it("title at 81 chars IS truncated with '...'", async () => {
      const sendNotification = await freshSendNotification();

      // title = `${username} in #general` => username.length + 12 = 81 => 69
      const username = "U".repeat(69);

      armDesktopPrefs();

      notifyAs(username, 1, "x");

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title.endsWith("...")).toBe(true);
        // Truncated to 80 chars + "..." = 83
        expect(call.title.length).toBe(83);
      });
    });

    it("body at exactly 100 chars is NOT truncated", async () => {
      const sendNotification = await armDesktopNotifications();

      const content = "B".repeat(100);
      notifyAs("X", 1, content);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body).toBe("B".repeat(100));
        expect(call.body.endsWith("...")).toBe(false);
      });
    });

    it("body at 101 chars IS truncated with '...'", async () => {
      const sendNotification = await armDesktopNotifications();

      const content = "B".repeat(101);
      notifyAs("X", 1, content);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body.endsWith("...")).toBe(true);
        expect(call.body.length).toBe(103); // 100 + "..."
      });
    });

    it("strips control characters from username and content", async () => {
      const sendNotification = await armDesktopNotifications();

      notifyAs("Evil\x00\x1FUser\x7F", 1, "Hello\x00World\x1F!\x7F");

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe("EvilUser in #general");
        expect(call.body).toBe("HelloWorld!");
      });
    });

    it("control chars are removed before length check (not counted)", async () => {
      const sendNotification = await armDesktopNotifications();

      // 100 visible chars + 5 control chars => after strip = 100, should NOT truncate
      const content = "C".repeat(100) + "\x00\x01\x02\x03\x04";
      notifyAs("U", 1, content);

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.body).toBe("C".repeat(100));
        expect(call.body.endsWith("...")).toBe(false);
      });
    });
  });

  describe("suppressEveryone: driven by mentions_everyone, not substrings", () => {
    it("suppresses an @everyone the server honoured", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", true);
      armDesktopPrefs();

      notifyIncomingMessage(makePayload({ content: "ping @everyone", mentions_everyone: true }));

      await new Promise((r) => setTimeout(r, 50));
      // Should NOT have reached sendNotification
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("suppresses an @here the server honoured", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", true);
      armDesktopPrefs();

      notifyIncomingMessage(makePayload({ content: "ping @here", mentions_everyone: true }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("does NOT suppress an @everyone the server did not honour", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", true);
      armDesktopPrefs();

      // Sender lacked MENTION_EVERYONE: the token is plain text.
      notifyIncomingMessage(makePayload({ content: "ping @everyone", mentions_everyone: false }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("does NOT suppress an @everyone that also names the user", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", true);
      armDesktopPrefs();

      notifyIncomingMessage(
        makePayload({ content: "@everyone and @Me", mentions: [1], mentions_everyone: true }),
      );

      await vi.waitFor(() => {
        const call = (sendNotification as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        expect(call.title).toBe("TestUser mentioned you in #general");
      });
    });

    it("does NOT suppress message without @everyone or @here even with toggle on", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", true);
      armDesktopPrefs();

      notifyIncomingMessage(makePayload({ content: "just a normal message" }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("does NOT suppress @everyone when suppressEveryone pref is false", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("suppressEveryone", false);
      armDesktopPrefs();

      notifyIncomingMessage(makePayload({ content: "Hey @everyone", mentions_everyone: true }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("guard clause: own message check", () => {
    it("skips notification when payload user ID matches current user ID exactly", async () => {
      const sendNotification = await freshSendNotification();

      testPrefs.set("desktopNotifications", true);

      // Current user id=1, payload user id=1
      const payload = makePayload({ user: { id: 1, username: "Me", avatar: null } });
      notifyIncomingMessage(payload);

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
    });

    it("proceeds when current user is null (not logged in) — does not crash", async () => {
      const sendNotification = await freshSendNotification();

      resetAuthState();

      armDesktopPrefs();

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("proceeds when payload user ID differs from current user ID", async () => {
      const sendNotification = await freshSendNotification();

      // Current user id=1, payload user id=2 (different)
      armDesktopPrefs();

      notifyIncomingMessage(makePayload({ user: { id: 2, username: "Other", avatar: null } }));

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });
  });

  describe("guard clause: focused window + active channel", () => {
    it("skips when BOTH window focused AND channel matches (AND, not OR)", async () => {
      const sendNotification = await freshSendNotification();

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

      setAlertPrefs(true, true, false);
      notifyIncomingMessage(makePayload({ channel_id: 1 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
      expect(win.requestUserAttention).not.toHaveBeenCalled();
    });

    it("proceeds when window NOT focused even for active channel", async () => {
      const sendNotification = await freshSendNotification();

      vi.spyOn(document, "hasFocus").mockReturnValue(false);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));

      armDesktopPrefs();

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
      const sendNotification = await freshSendNotification();

      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
      messagesStore.setState((prev) => ({ ...prev, detachedChannels: new Set([1]) }));

      armDesktopPrefs();

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

      armDesktopPrefs();

      mockOscillator.start.mockClear();

      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });

      // Sound oscillator should not have been started
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("fires ONLY notification sound when other toggles are off", async () => {
      const sendNotification = await freshSendNotification();

      setAlertPrefs(false, false, true);
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

      setAlertPrefs(false, true, false);
      notifyIncomingMessage(makePayload());

      await vi.waitFor(() => {
        const win = getCurrentWindow();
        expect(win.requestUserAttention).toHaveBeenCalled();
      });

      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });
  });
});
