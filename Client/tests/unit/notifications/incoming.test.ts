import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/notificationsMocks";
import { notifyIncomingMessage, resetNotificationCoalescing } from "../../../src/lib/notifications";
import { authStore } from "../../../src/stores/auth.store";
import { channelsStore } from "../../../src/stores/channels.store";
import { dmStore } from "../../../src/stores/dm.store";
import type { DmChannel } from "../../../src/stores/dm.store";
import { setBlockedByMe } from "../../../src/stores/blocks.store";
import { setLogLevel } from "../../../src/lib/logger";
import {
  freshSendNotification,
  armDesktopPrefs,
  makePayload,
  setAlertPrefs,
  useNotificationsHarness,
  freshAlertSpies,
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

const { testPrefs, shouldTauriNotifThrow, mockOscillator } = mocks;

// The three tests that assert on the logger's debug lines raise the level the
// global setup lowered (C-04) for themselves; this puts it back.
afterEach(() => {
  setLogLevel("warn");
});

/** Makes the Tauri path throw and installs a fake Web Notification with the given permission. */
function stubWebNotification(
  permission: string,
  requestResult?: string,
): {
  mockWebNotification: ReturnType<typeof vi.fn>;
  mockRequestPerm: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  shouldTauriNotifThrow.value = true;
  const mockWebNotification = vi.fn();
  const mockRequestPerm = requestResult ? vi.fn().mockResolvedValue(requestResult) : vi.fn();
  const originalNotification = globalThis.Notification;
  (globalThis as Record<string, unknown>).Notification = Object.assign(mockWebNotification, {
    permission,
    requestPermission: mockRequestPerm,
  });
  return {
    mockWebNotification,
    mockRequestPerm,
    restore: () => {
      shouldTauriNotifThrow.value = false;
      (globalThis as Record<string, unknown>).Notification = originalNotification;
    },
  };
}

async function notifyAndSettle(): Promise<void> {
  armDesktopPrefs();
  notifyIncomingMessage(makePayload());
  await new Promise((r) => setTimeout(r, 50));
}

describe("notifyIncomingMessage", () => {
  useNotificationsHarness();

  it("does not notify for own messages", async () => {
    const sendNotification = await freshSendNotification();
    const payload = makePayload({ user: { id: 1, username: "Me", avatar: null } });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("makes no sound and no OS toast for a call log row", async () => {
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 1 }));
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("with document.hasFocus() true and a message in a non-active channel, no OS notification and no taskbar flash fire", async () => {
    const { sendNotification, win } = await freshAlertSpies();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    channelsStore.setState((prev) => ({ ...prev, activeChannelId: 2 }));
    setAlertPrefs(true, true, true);
    const payload = makePayload({ channel_id: 1 });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
    expect(win.requestUserAttention).not.toHaveBeenCalled();
    // D3 (b), Discord desktop: the chime still plays while focused.
    expect(mockOscillator.start).toHaveBeenCalled();
  });

  it("suppresses @everyone when toggle is enabled", async () => {
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
    testPrefs.set("suppressEveryone", false);
    const payload = makePayload({ content: "Hey @everyone check this out" });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("role mention notifies a holder", async () => {
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Hey @here important update", mentions_everyone: true });
    notifyIncomingMessage(payload);
    await new Promise((r) => setTimeout(r, 50));
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("skips desktop notification when toggle is off", async () => {
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
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
    const sendNotification = await freshSendNotification();
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
      const { sendNotification, win } = await freshAlertSpies();
      setAlertPrefs(true, true, true);
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
    const sendNotification = await freshSendNotification();
    resetAuthState();
    // payload.user.id = 2 (different from null user), should proceed
    const payload = makePayload();
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("fires all notification types when all enabled", async () => {
    const { sendNotification, win } = await freshAlertSpies();

    // All defaults are true, so just fire and confirm all three channels fired
    setAlertPrefs(true, true, true);
    const payload = makePayload();
    notifyIncomingMessage(payload);

    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
      expect(win.requestUserAttention).toHaveBeenCalled();
    });
    expect(mockOscillator.start).toHaveBeenCalled();
  });

  it("handles short content without truncation", async () => {
    const sendNotification = await freshSendNotification();
    const payload = makePayload({ content: "Hi" });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "Hi" }));
    });
  });

  it("handles content exactly at 100 char boundary", async () => {
    const sendNotification = await freshSendNotification();
    const payload = makePayload({ content: "A".repeat(100) });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "A".repeat(100) }),
      );
    });
  });

  it("handles content just over 100 chars (101)", async () => {
    const sendNotification = await freshSendNotification();
    const payload = makePayload({ content: "A".repeat(101) });
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ body: "A".repeat(100) + "..." }),
      );
    });
  });

  it("does not suppress normal message when suppressEveryone is enabled", async () => {
    const sendNotification = await freshSendNotification();
    testPrefs.set("suppressEveryone", true);
    const payload = makePayload({ content: "Normal message without at-mentions" });
    // Should proceed to notification (not suppressed)
    notifyIncomingMessage(payload);
    await vi.waitFor(() => {
      expect(sendNotification).toHaveBeenCalled();
    });
  });

  it("suppresses @everyone regardless of other toggles", async () => {
    const sendNotification = await freshSendNotification();
    testPrefs.set("suppressEveryone", true);
    setAlertPrefs(true, true, true);
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

    setAlertPrefs(false, false, true);
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
    const { mockWebNotification, restore } = stubWebNotification("granted");

    await notifyAndSettle();

    expect(mockWebNotification).toHaveBeenCalled();

    restore();
  });

  it("falls back to Web Notification API and requests permission when not granted/denied", async () => {
    const { mockWebNotification, mockRequestPerm, restore } = stubWebNotification(
      "default",
      "granted",
    );

    await notifyAndSettle();

    expect(mockRequestPerm).toHaveBeenCalled();
    expect(mockWebNotification).toHaveBeenCalled();

    restore();
  });

  it("does not show Web Notification when permission is denied", async () => {
    const { mockWebNotification, restore } = stubWebNotification("denied");

    await notifyAndSettle();

    expect(mockWebNotification).not.toHaveBeenCalled();

    restore();
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

    armDesktopPrefs();

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
    const { mockWebNotification, mockRequestPerm, restore } = stubWebNotification(
      "default",
      "denied",
    );

    await notifyAndSettle();

    expect(mockRequestPerm).toHaveBeenCalled();
    // Should not construct a Notification since permission denied
    expect(mockWebNotification).not.toHaveBeenCalled();

    restore();
  });
});
