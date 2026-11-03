/**
 * The Android app's alerts: the popup shows while the app is open on another
 * channel, never for the channel on screen, Android's own sound replaces the
 * chime, and a message never asks for the permission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/notificationsMocks";
import { mockOscillator, testPrefs } from "../../helpers/notificationsMocks";
import { makePayload, useNotificationsHarness } from "../../helpers/notificationsHarness";
import { expectConsole } from "../../helpers/console";
import type { NotificationTarget } from "../../../src/platform/contracts/notifications";

const notifier = vi.hoisted(() => ({
  readsOsPermission: true,
  permissionGranted: vi.fn<() => Promise<boolean>>(),
  requestPermission: vi.fn<() => Promise<boolean>>(),
  showMessage: vi.fn<(title: string, body: string, target: NotificationTarget) => Promise<void>>(),
  flashTaskbar: vi.fn<() => Promise<void>>(),
}));
const host = vi.hoisted(() => ({ android: true }));

vi.mock("../../../src/lib/hostPlatform", () => ({ isAndroidHost: () => host.android }));
vi.mock("../../../src/platform/desktop", () => ({ desktop: { notifier } }));
vi.mock("../../../src/lib/prefs/preferences", (importOriginal) =>
  mocks.prefsPreferencesMock(importOriginal),
);
vi.mock("../../../src/lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

await import("../../../src/lib/text/markdown");
const { notifyIncomingMessage, notifyChannelActivity } =
  await import("../../../src/lib/notifications");

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

/** A plain message from user 2 in `channelId`. */
const messageIn = (channelId: number) =>
  makePayload({ id: 9, channel_id: channelId, user: { id: 2, username: "bob", avatar: null } });

useNotificationsHarness();

beforeEach(() => {
  host.android = true;
  notifier.permissionGranted.mockReset().mockResolvedValue(true);
  notifier.requestPermission.mockReset().mockResolvedValue(true);
  notifier.showMessage.mockReset().mockResolvedValue(undefined);
  notifier.flashTaskbar.mockReset().mockResolvedValue(undefined);
  mockOscillator.start.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("on the phone with the app in front", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("shows a message from another channel, opening that message", async () => {
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.showMessage).toHaveBeenCalledTimes(1);
    expect(notifier.showMessage.mock.calls[0]?.[2]).toEqual({
      host: "",
      channelId: 2,
      messageId: 9,
    });
  });

  it("shows nothing for a message in the channel on screen", async () => {
    notifyIncomingMessage(messageIn(1));
    await settle();
    expect(notifier.showMessage).not.toHaveBeenCalled();
    expect(mockOscillator.start).not.toHaveBeenCalled();
  });

  it("shows activity from a channel not on screen", async () => {
    notifyChannelActivity({
      channel_id: 1,
      message_id: 42,
      author_id: 2,
      mentions_you: false,
      mentions_everyone: false,
    });
    await settle();
    expect(notifier.showMessage).not.toHaveBeenCalled();

    notifyChannelActivity({
      channel_id: 3,
      message_id: 43,
      author_id: 2,
      mentions_you: false,
      mentions_everyone: false,
    });
    await settle();
    expect(notifier.showMessage).toHaveBeenCalledTimes(1);
  });
});

describe("the sound on the phone", () => {
  it("leaves the sound to Android when the notification shows", async () => {
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.showMessage).toHaveBeenCalledTimes(1);
    expect(mockOscillator.start).not.toHaveBeenCalled();
  });

  it("plays the chime when Android blocks the notification", async () => {
    notifier.permissionGranted.mockResolvedValue(false);
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.showMessage).not.toHaveBeenCalled();
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
  });

  it("plays the chime when the notification fails", async () => {
    notifier.showMessage.mockRejectedValue(new Error("channel missing"));
    notifyIncomingMessage(messageIn(2));
    await settle();
    expectConsole("warn", /Notification not shown/);
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
  });

  it("plays the chime when notifications are off in OwnCord", async () => {
    testPrefs.set("desktopNotifications", false);
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.showMessage).not.toHaveBeenCalled();
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
  });
});

describe("the permission on the phone", () => {
  it("is not asked for by an incoming message", async () => {
    notifier.permissionGranted.mockResolvedValue(false);
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.requestPermission).not.toHaveBeenCalled();
  });
});

describe("the desktop with the window in front", () => {
  it("keeps only the chime for another channel", async () => {
    host.android = false;
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    notifyIncomingMessage(messageIn(2));
    await settle();
    expect(notifier.showMessage).not.toHaveBeenCalled();
    expect(mockOscillator.start).toHaveBeenCalledTimes(1);
  });
});
