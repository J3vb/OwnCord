import { vi, beforeEach, expect } from "vitest";
import { notifyIncomingMessage, resetNotificationCoalescing } from "../../src/lib/notifications";
import { channelsStore } from "../../src/stores/channels.store";
import { dmStore } from "../../src/stores/dm.store";
import { membersStore } from "../../src/stores/members.store";
import { messagesStore } from "../../src/stores/messages.store";
import { mockOscillator, testPrefs } from "./notificationsMocks";
import { signInAs } from "./storeSeeds";
import { dmRecipient, makeDm } from "./dmHarness";
import { makeChannel } from "./channelFactory";
import { makePayload } from "./chatPayload";

export { makePayload };

/** One text channel, "general" (id 1), as the only channel; `activeChannelId` is the one being viewed. */
export function seedGeneralChannel(activeChannelId: number | null): void {
  channelsStore.setState(() => ({
    categories: [],
    channels: new Map([[1, makeChannel()]]),
    activeChannelId,
    roles: [],
  }));
}

/** Registers the shared beforeEach for the "notifyIncomingMessage" describe. */
export function useNotificationsHarness(): void {
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
    signInAs(
      { id: 1, username: "Me", avatar: null, role: "member" },
      { token: "test", serverName: null },
    );

    seedGeneralChannel(1);

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
}

type SendNotificationMock = ReturnType<typeof vi.fn>;

/** The plugin's sendNotification mock with its call history cleared. */
export async function freshSendNotification(): Promise<SendNotificationMock> {
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  (sendNotification as SendNotificationMock).mockClear();
  return sendNotification as SendNotificationMock;
}

/** The notification plugin's sendNotification and the window, with their call history and the chime cleared. */
export async function freshAlertSpies() {
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  (sendNotification as SendNotificationMock).mockClear();
  (win.requestUserAttention as SendNotificationMock).mockClear();
  mockOscillator.start.mockClear();
  return { sendNotification, win };
}

/** The Tauri invoke mock and the window, with their call history and the chime cleared. */
export async function freshInvokeSpies() {
  const { invoke } = await import("@tauri-apps/api/core");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  (invoke as SendNotificationMock).mockClear();
  (win.requestUserAttention as SendNotificationMock).mockClear();
  mockOscillator.start.mockClear();
  return { invoke: invoke as SendNotificationMock, win };
}

export function setAlertPrefs(desktop: boolean, flash: boolean, sounds: boolean): void {
  testPrefs.set("desktopNotifications", desktop);
  testPrefs.set("flashTaskbar", flash);
  testPrefs.set("notificationSounds", sounds);
}

/** Desktop notifications on; taskbar flash and sounds off. */
export function armDesktopPrefs(): void {
  setAlertPrefs(true, false, false);
}

export async function armDesktopNotifications(): Promise<SendNotificationMock> {
  const sendNotification = await freshSendNotification();
  armDesktopPrefs();
  return sendNotification;
}

/** Opens a one-to-one DM with bob on channel 55, which channelsStore does not know. */
export function seedBobDm(): void {
  const bob = dmRecipient(2, "bob");
  dmStore.setState(() => ({
    channels: [makeDm({ channelId: 55, recipient: bob, participants: [bob] })],
  }));
}

/** Seeds member 2, "a_martinez", whose nickname is Alice. */
export function seedNicknamedMember(roleRevision: number): void {
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
    roleRevision,
  }));
}

/** Waits out the async paths, then asserts no popup, chime or taskbar flash happened. */
export async function expectNoAlerts(
  invoke: unknown,
  win: { requestUserAttention: unknown },
): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  expect(invoke).not.toHaveBeenCalled();
  expect(mockOscillator.start).not.toHaveBeenCalled();
  expect(win.requestUserAttention).not.toHaveBeenCalled();
}

/** Delivers a plain message from user 2 through notifyIncomingMessage. */
export function notifyAs(username: string, channelId: number, content: string): void {
  notifyIncomingMessage(
    makePayload({ user: { id: 2, username, avatar: null }, channel_id: channelId, content }),
  );
}
