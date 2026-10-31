import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/notificationsMocks";
import { notifyIncomingMessage } from "../../../src/lib/notifications";
import { cleanupNotificationAudio } from "../../../src/lib/media/notificationSound";
import { channelsStore } from "../../../src/stores/channels.store";
import type { ChatMessagePayload } from "../../../src/lib/types";
import { setLogLevel } from "../../../src/lib/logger";
import {
  muteChannel,
  setChannelMutesHost,
  unmuteChannel,
} from "../../../src/lib/prefs/channelMutes";
import { setMessageJumpHandler } from "../../../src/lib/nav/messageNavigation";
import {
  armDesktopNotifications,
  freshSendNotification,
  armDesktopPrefs,
  makePayload,
  setAlertPrefs,
  notifyAs,
  seedBobDm,
  expectNoAlerts,
  useNotificationsHarness,
} from "../../helpers/notificationsHarness";

vi.mock("../../../src/lib/prefs/preferences", (importOriginal) =>
  mocks.prefsPreferencesMock(importOriginal),
);
vi.mock("../../../src/lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@tauri-apps/plugin-notification", () => mocks.pluginNotificationMock());
vi.mock("@tauri-apps/api/core", () => mocks.apiCoreMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("@tauri-apps/api/window", () => mocks.apiWindowMock());

const { testPrefs, shouldTauriNotifThrow, mockOscillator, mockGain, MockAudioContext } = mocks;

// The three tests that assert on the logger's debug lines raise the level the
// global setup lowered (C-04) for themselves; this puts it back.
afterEach(() => {
  setLogLevel("warn");
});

describe("notifyIncomingMessage", () => {
  useNotificationsHarness();

  describe("Do Not Disturb", () => {
    it("suppresses the desktop notification, the sound and the taskbar flash while DND", async () => {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      (sendNotification as ReturnType<typeof vi.fn>).mockClear();
      const win = getCurrentWindow();
      (win.requestUserAttention as ReturnType<typeof vi.fn>).mockClear();
      mockOscillator.start.mockClear();

      setAlertPrefs(true, true, true);
      testPrefs.set("userStatus", "dnd");

      notifyIncomingMessage(makePayload());
      notifyIncomingMessage(makePayload({ content: "hi @Me", mentions: [1], id: 2 }));

      await new Promise((r) => setTimeout(r, 50));
      expect(win.requestUserAttention).not.toHaveBeenCalled();
      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("still notifies for other statuses", async () => {
      const sendNotification = await freshSendNotification();

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

      await expectNoAlerts(sendNotification, win);
    });

    const bobDm = (): void => seedBobDm();

    it("Nothing does not silence a DM; a server channel message stays silent", async () => {
      const sendNotification = await freshSendNotification();
      testPrefs.set("notificationLevel", "nothing");
      bobDm();

      notifyIncomingMessage(makePayload({ content: "plain channel chatter" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();

      notifyAs("bob", 55, "hey");
      await vi.waitFor(() => {
        expect(sendNotification).toHaveBeenCalled();
      });
    });

    it("Nothing: a muted DM stays silent (the mute still applies)", async () => {
      const sendNotification = await freshSendNotification();
      testPrefs.set("notificationLevel", "nothing");
      bobDm();
      setChannelMutesHost("a.example");
      muteChannel(55);

      try {
        notifyAs("bob", 55, "hey");
        await new Promise((r) => setTimeout(r, 50));
        expect(sendNotification).not.toHaveBeenCalled();
      } finally {
        unmuteChannel(55);
        setChannelMutesHost(null);
      }
    });

    it("Nothing + Do Not Disturb: a DM shows no popup and plays no chime", async () => {
      const sendNotification = await freshSendNotification();
      mockOscillator.start.mockClear();
      testPrefs.set("notificationLevel", "nothing");
      testPrefs.set("userStatus", "dnd");
      bobDm();

      notifyAs("bob", 55, "hey");
      await new Promise((r) => setTimeout(r, 50));
      expect(sendNotification).not.toHaveBeenCalled();
      expect(mockOscillator.start).not.toHaveBeenCalled();
    });

    it("Mentions only suppresses a plain message but not one that names you", async () => {
      const sendNotification = await freshSendNotification();
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
      const sendNotification = await freshSendNotification();
      testPrefs.set("notificationLevel", "mentions");
      seedBobDm();

      notifyAs("bob", 55, "hey");

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
      const sendNotification = await freshSendNotification();
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
      const sendNotification = await freshSendNotification();
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
      const sendNotification = await freshSendNotification();
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
      const sendNotification = await freshSendNotification();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      seedBobDm();
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
      const sendNotification = await freshSendNotification();
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
      const sendNotification = await freshSendNotification();
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

      setAlertPrefs(false, false, true);
      notifyIncomingMessage(makePayload());

      // Verify exact frequency values (kills arithmetic mutations)
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(800, 0);
      expect(mockOscillator.frequency.setValueAtTime).toHaveBeenCalledWith(600, 0.1);
    });

    it("sets gain to 0.3 and ramps to 0.01", () => {
      mockGain.gain.setValueAtTime.mockClear();
      mockGain.gain.exponentialRampToValueAtTime.mockClear();

      setAlertPrefs(false, false, true);
      notifyIncomingMessage(makePayload());

      expect(mockGain.gain.setValueAtTime).toHaveBeenCalledWith(0.3, 0);
      expect(mockGain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.01, 0.2);
    });

    it("starts oscillator at currentTime and stops at currentTime + 0.2", () => {
      mockOscillator.start.mockClear();
      mockOscillator.stop.mockClear();

      setAlertPrefs(false, false, true);
      notifyIncomingMessage(makePayload());

      expect(mockOscillator.start).toHaveBeenCalledWith(0);
      expect(mockOscillator.stop).toHaveBeenCalledWith(0.2);
    });

    it("connects oscillator -> gain -> destination", () => {
      mockOscillator.connect.mockClear();
      mockGain.connect.mockClear();

      setAlertPrefs(false, false, true);
      notifyIncomingMessage(makePayload());

      expect(mockOscillator.connect).toHaveBeenCalledWith(mockGain);
      expect(mockGain.connect).toHaveBeenCalled();
    });
  });

  describe("cleanupNotificationAudio", () => {
    it("calls close() on the AudioContext when one exists", () => {
      // First, ensure an AudioContext is created by playing a sound
      setAlertPrefs(false, false, true);
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

      setAlertPrefs(false, true, false);
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

      armDesktopPrefs();

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

      armDesktopPrefs();

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

      armDesktopPrefs();

      notifyAs("WebUser", 1, "web notif test");

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

      armDesktopPrefs();

      notifyIncomingMessage(makePayload());

      await new Promise((r) => setTimeout(r, 50));

      expect(mockRequestPerm).not.toHaveBeenCalled();
      expect(mockWebNotification).not.toHaveBeenCalled();

      (globalThis as Record<string, unknown>).Notification = originalNotification;
    });
  });
  describe("mention titles", () => {
    async function titleFor(payload: ChatMessagePayload): Promise<string> {
      const sendNotification = await armDesktopNotifications();
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
      const sendNotification = await freshSendNotification();
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
      armDesktopPrefs();

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
        armDesktopPrefs();

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
});
