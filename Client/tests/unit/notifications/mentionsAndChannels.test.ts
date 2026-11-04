import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/notificationsMocks";
import {
  notifyChannelActivity,
  notifyIncomingMessage,
  notifyMention,
  openMessageTarget,
} from "../../../src/lib/notifications";
import { channelsStore } from "../../../src/stores/channels.store";
import { setBlockedByMe } from "../../../src/stores/blocks.store";
import type { ChannelActivityEntry } from "../../../src/lib/types";
import { setLogLevel } from "../../../src/lib/logger";
import {
  muteChannel,
  setChannelMutesHost,
  unmuteChannel,
} from "../../../src/lib/prefs/channelMutes";
import { setMessageJumpHandler } from "../../../src/lib/nav/messageNavigation";
import {
  expectNoAlerts,
  makePayload,
  seedBobDm,
  useNotificationsHarness,
  seedNicknamedMember,
  freshInvokeSpies,
} from "../../helpers/notificationsHarness";

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

  describe("notifyMention", () => {
    async function spies() {
      return freshInvokeSpies();
    }

    it("Nothing silences the popup, the chime and the flash", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("notificationLevel", "nothing");

      notifyMention(1);

      await expectNoAlerts(invoke, win);
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

      await expectNoAlerts(invoke, win);
    });

    it("Do Not Disturb suppresses the popup, the chime and the taskbar flash", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("userStatus", "dnd");

      notifyMention(1);

      await expectNoAlerts(invoke, win);
    });

    it("stays silent while Suppress @everyone is on", async () => {
      const { invoke, win } = await spies();
      testPrefs.set("suppressEveryone", true);

      try {
        notifyMention(1);

        await expectNoAlerts(invoke, win);
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
      seedBobDm();

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
      return freshInvokeSpies();
    }

    beforeEach(() => {
      seedNicknamedMember(0);
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

      await expectNoAlerts(invoke, win);
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
      seedBobDm();

      notifyIncomingMessage(makePayload({ channel_id: 55, content: "psst" }));

      await vi.waitFor(() => {
        expect(seen.count()).toBeGreaterThan(0);
      });
    });
  });
});
